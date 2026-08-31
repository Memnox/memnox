import { DECISION_EFFECT, type ActionRequest } from '@memnox/core';
import { LocalGate } from '@memnox/local-gate';
import { describe, expect, it } from 'vitest';
import type { HookAuthorizer } from '../src/hook-authorizer';
import { HookAuthorizer as RealAuthorizer } from '../src/hook-authorizer';
import {
  DockerSeam,
  dockerActionFor,
  DOCKER_READ_ACTION,
  DOCKER_DEFAULT_ACTION,
} from '../src/docker-seam';
import { DOCKER_SOCKET_PATH_LIMIT } from '../src/tool-hook.constants';
import {
  EgressSeam,
  EGRESS_BLIND_SPOTS,
  EGRESS_CONNECT_ACTION,
  EGRESS_REQUEST_ACTION,
} from '../src/egress-seam';

const AWS_KEY = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');

class StubAuthorizer {
  readonly seen: ActionRequest[] = [];
  constructor(
    private readonly verdict: {
      effect: string;
      reason: string;
      alternative?: { action: string; resource?: string; note: string };
    },
  ) {}
  async authorize(request: ActionRequest): Promise<typeof this.verdict> {
    this.seen.push(request);
    return this.verdict;
  }
}

const as = (stub: StubAuthorizer): HookAuthorizer => stub as unknown as HookAuthorizer;
const allow = { effect: DECISION_EFFECT.ALLOW, reason: 'no rule matched' };

describe('the egress seam', () => {
  it('lets an ordinary request through', async () => {
    const stub = new StubAuthorizer(allow);
    const outcome = await new EgressSeam({ authorizer: as(stub) }).gateRequest({
      method: 'POST',
      url: 'https://api.example.com/v1/notes',
      body: 'the quarterly numbers',
    });

    expect(outcome.allowed).toBe(true);
    expect(stub.seen[0]?.action).toBe(EGRESS_REQUEST_ACTION);
    expect(stub.seen[0]?.target).toBe('https://api.example.com/v1/notes');
  });

  /** An allowed host carrying a credential is still a refusal. */
  it('refuses a credential in the body even when no rule forbids the host', async () => {
    const stub = new StubAuthorizer(allow);
    const outcome = await new EgressSeam({ authorizer: as(stub) }).gateRequest({
      method: 'POST',
      url: 'https://api.partner.example/ingest',
      body: `config=${AWS_KEY}`,
    });

    expect(outcome.allowed).toBe(false);
    expect(outcome.message).toContain('body');
    // Never the value: the refusal names the field so a rule can be argued with.
    expect(outcome.message).not.toContain(AWS_KEY);
    // Refused before anything was asked, so the payload never left this machine.
    expect(stub.seen).toEqual([]);
  });

  it('rules on a credential in a header too', async () => {
    const outcome = await new EgressSeam({
      authorizer: as(new StubAuthorizer(allow)),
    }).gateRequest({
      method: 'GET',
      url: 'https://example.com',
      headers: { authorization: `Bearer ${'a'.repeat(40)}` },
    });

    expect(outcome.allowed).toBe(false);
    expect(outcome.message).toContain('authorization');
  });

  it('carries a refused destination’s alternative to the caller', async () => {
    const outcome = await new EgressSeam({
      authorizer: as(
        new StubAuthorizer({
          effect: DECISION_EFFECT.WITHHOLD,
          reason: 'paste hosts are how data leaves quietly',
          alternative: { action: 'http.request', note: 'post it to the internal wiki' },
        }),
      ),
    }).gateRequest({ method: 'POST', url: 'https://pastebin.com/api', body: 'notes' });

    expect(outcome.message).toContain('Instead: http.request');
  });

  it('rules on a tunnel by destination, which is all there is to rule on', async () => {
    const stub = new StubAuthorizer(allow);
    const outcome = await new EgressSeam({ authorizer: as(stub) }).gateConnect(
      'github.com:443',
    );

    expect(outcome.allowed).toBe(true);
    expect(stub.seen[0]?.action).toBe(EGRESS_CONNECT_ACTION);
    expect(stub.seen[0]?.target).toBe('github.com:443');
    // No payload is claimed, because none is visible.
    expect(stub.seen[0]?.arguments).toBeUndefined();
  });

  it('refuses a tunnel to a destination a rule forbids', async () => {
    const outcome = await new EgressSeam({
      authorizer: as(
        new StubAuthorizer({
          effect: DECISION_EFFECT.WITHHOLD,
          reason: 'not an approved destination',
        }),
      ),
    }).gateConnect('paste.example:443');

    expect(outcome.allowed).toBe(false);
    expect(outcome.message).toContain('not an approved destination');
  });

  /** A governed agent with an unwatched side channel is worse than an ungoverned one. */
  it('says plainly that a tunnelled body is unseen', () => {
    expect(EGRESS_BLIND_SPOTS[0]).toContain('HTTPS tunnel');
  });

  it('withholds against a real rule with no runtime', async () => {
    const gate = new LocalGate(
      [
        {
          name: 'no-paste-hosts',
          match: { actions: ['http.request'], targets: ['*pastebin.com*'] },
          decision: { effect: DECISION_EFFECT.WITHHOLD, reason: 'paste host' },
        },
      ],
      { agentName: 'claude-code' },
    );
    const seam = new EgressSeam({
      authorizer: new RealAuthorizer({ gate, log: () => {} }),
    });

    expect(
      (await seam.gateRequest({ method: 'POST', url: 'https://pastebin.com/x' })).allowed,
    ).toBe(false);
    expect(
      (await seam.gateRequest({ method: 'GET', url: 'https://example.com' })).allowed,
    ).toBe(true);
  });
});

describe('dockerActionFor', () => {
  it.each([
    ['POST', '/v1.43/containers/create', 'container.create'],
    ['POST', '/containers/abc/exec', 'container.exec'],
    ['POST', '/v1.43/exec/abc/start', 'container.exec'],
    ['POST', '/containers/abc/start', 'container.start'],
    ['DELETE', '/v1.43/containers/abc', 'container.delete'],
    ['DELETE', '/images/ubuntu', 'image.delete'],
    ['POST', '/build', 'image.build'],
    ['GET', '/containers/json', DOCKER_READ_ACTION],
    ['POST', '/networks/create', DOCKER_DEFAULT_ACTION],
  ])('names %s %s as its action', (method, path, action) => {
    expect(dockerActionFor({ method, path })).toBe(action);
  });

  it('reads a version prefix as the same call', () => {
    expect(dockerActionFor({ method: 'POST', path: '/v1.41/containers/create' })).toBe(
      dockerActionFor({ method: 'POST', path: '/containers/create' }),
    );
  });
});

/**
 * A path over the cap binds nothing while `listen` still reports success, which would
 * leave the seam announcing coverage it does not have. Found the hard way.
 */
describe('the docker socket path limit', () => {
  it('is under what the operating system accepts', () => {
    expect(DOCKER_SOCKET_PATH_LIMIT).toBeLessThanOrEqual(104);
  });

  it('rejects a path a real temp directory can easily produce', () => {
    const realistic = `/private/tmp/claude-501/${'a'.repeat(80)}/memnox-docker.sock`;
    expect(Buffer.byteLength(realistic)).toBeGreaterThan(DOCKER_SOCKET_PATH_LIMIT);
  });
});

describe('the docker seam', () => {
  it('lets an ordinary read through, named as a read', async () => {
    const stub = new StubAuthorizer(allow);
    const outcome = await new DockerSeam({ authorizer: as(stub) }).gate({
      method: 'GET',
      path: '/containers/json',
    });

    expect(outcome.allowed).toBe(true);
    expect(outcome.action).toBe(DOCKER_READ_ACTION);
  });

  it('refuses an exec into a container, which is a shell on the host', async () => {
    const outcome = await new DockerSeam({
      authorizer: as(
        new StubAuthorizer({
          effect: DECISION_EFFECT.WITHHOLD,
          reason: 'an exec is a shell nobody watched',
        }),
      ),
    }).gate({ method: 'POST', path: '/v1.43/containers/abc/exec' });

    expect(outcome.allowed).toBe(false);
    expect(outcome.action).toBe('container.exec');
    expect(outcome.message).toContain('nobody watched');
  });

  it('carries the call for a rule to match on', async () => {
    const stub = new StubAuthorizer(allow);
    await new DockerSeam({ authorizer: as(stub), sessionId: 'ses_1' }).gate({
      method: 'DELETE',
      path: '/images/ubuntu',
    });

    expect(stub.seen[0]?.action).toBe('image.delete');
    expect(stub.seen[0]?.arguments).toEqual({
      method: 'DELETE',
      path: '/images/ubuntu',
    });
    expect(stub.seen[0]?.sessionId).toBe('ses_1');
  });

  it('withholds a destructive call against a real rule, with no runtime', async () => {
    const gate = new LocalGate(
      [
        {
          name: 'no-container-exec',
          match: { actions: ['container.exec'] },
          decision: { effect: DECISION_EFFECT.WITHHOLD, reason: 'exec needs a person' },
        },
      ],
      { agentName: 'claude-code' },
    );
    const seam = new DockerSeam({
      authorizer: new RealAuthorizer({ gate, log: () => {} }),
    });

    expect(
      (await seam.gate({ method: 'POST', path: '/containers/a/exec' })).allowed,
    ).toBe(false);
    expect((await seam.gate({ method: 'GET', path: '/containers/json' })).allowed).toBe(
      true,
    );
  });
});
