import { createServer, request, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DECISION_EFFECT,
  DestinationRecords,
  ENV_AGENT_NAME,
  PROBATION_KIND,
  ProbationRegister,
  type MemnoxEvent,
} from '@memnox/core';
import { containmentFor } from '../src/containment-loader';
import { EgressSeam, type EgressRuling } from '../src/egress-seam';
import {
  callerOf,
  egressEventFor,
  proxyUrlFor,
  recordEgress,
  startEgressProxy,
  type EgressProxy,
} from '../src/egress-server';
import { HookAuthorizer } from '../src/hook-authorizer';

const NOW = new Date('2026-09-24T10:00:00.000Z');

function basicOf(url: string): string {
  const parsed = new URL(url);
  const pair = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`;
  return `Basic ${Buffer.from(pair).toString('base64')}`;
}

describe('who a proxied request came from', () => {
  it('rides in the proxy URL and is read back off the credentials', () => {
    const url = proxyUrlFor(8888, { sessionId: 'ses_abc', agent: 'claude-code' });
    expect(url).toBe('http://ses_abc:claude-code@127.0.0.1:8888');
    expect(callerOf({ 'proxy-authorization': basicOf(url) })).toEqual({
      sessionId: 'ses_abc',
      agent: 'claude-code',
    });
  });

  it('is nobody in particular when the client sent no credentials', () => {
    expect(proxyUrlFor(8888)).toBe('http://127.0.0.1:8888');
    expect(callerOf({})).toEqual({});
  });
});

describe('a proxy ruling on a caller that is on probation', () => {
  it('asks rather than allows, and nobody to ask means it does not go', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-egress-probation-'));
    await new ProbationRegister(home).start(
      { kind: PROBATION_KIND.AGENT, name: 'cursor' },
      NOW,
    );
    const seam = new EgressSeam({
      authorizer: new HookAuthorizer({}),
      contain: (caller) =>
        containmentFor({
          home,
          env: caller.agent === undefined ? {} : { [ENV_AGENT_NAME]: caller.agent },
          cwd: home,
          now: NOW,
          rootOf: () => null,
        }),
    });
    const outcome = await seam.gateConnect('api.example.com:443', { agent: 'cursor' });
    expect(outcome.allowed).toBe(false);
    expect(outcome.message).toContain('cursor is on probation');
    // The agent's own model provider is never held up on probation's account.
    expect(
      (await seam.gateConnect('api.anthropic.com:443', { agent: 'cursor' })).allowed,
    ).toBe(true);
    // Another agent is not on probation, so the same host goes.
    expect(
      (await seam.gateConnect('api.example.com:443', { agent: 'codex-cli' })).allowed,
    ).toBe(true);
  });
});

describe('what each ruling leaves behind', () => {
  it('is a ledger row naming the host only, and a destination for the agent that reached it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-egress-record-'));
    const rows: MemnoxEvent[] = [];
    const ledger = {
      append: async (row: MemnoxEvent) => void rows.push(row),
      query: async () => [],
    };
    const destinations = new DestinationRecords(home);
    const record = recordEgress(ledger, destinations, () => NOW);
    const ruling: EgressRuling = {
      caller: { sessionId: 'ses_1', agent: 'claude-code' },
      action: 'http.request',
      target: 'https://api.example.com/v1/items?token=secret',
      effect: DECISION_EFFECT.ALLOW,
      reason: 'allowed',
    };
    await record(ruling);
    await record({
      ...ruling,
      target: 'https://blocked.example/x',
      effect: DECISION_EFFECT.DENY,
    });

    expect(rows.map((row) => row.target)).toEqual(['api.example.com', 'blocked.example']);
    expect(rows[0]?.surface).toBe('network');
    expect(JSON.stringify(rows)).not.toContain('secret');
    const seen = await destinations.read('claude-code');
    // Reached is recorded; refused never was reached.
    expect(seen.hosts.map((each) => each.host)).toEqual(['api.example.com']);
    expect(egressEventFor(ruling, NOW.toISOString()).sessionId).toBe('ses_1');
  });
});

describe('the proxy as a server, on loopback only', () => {
  const opened: (EgressProxy | Server)[] = [];
  afterEach(async () => {
    for (const each of opened.splice(0)) {
      await new Promise<void>((resolve) => {
        if ('port' in each) void each.close().then(resolve);
        else each.close(() => resolve());
      });
    }
  });

  async function upstream(): Promise<number> {
    const server = createServer((_req, res) => res.end('upstream says hi'));
    opened.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    return typeof address === 'object' && address !== null ? address.port : 0;
  }

  function get(
    proxyPort: number,
    target: string,
    auth: string,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: proxyPort,
          path: target,
          headers: { 'proxy-authorization': auth },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('forwards an allowed request, and tells the seam who asked', async () => {
    const port = await upstream();
    const rulings: EgressRuling[] = [];
    const seam = new EgressSeam({
      authorizer: new HookAuthorizer({}),
      ruled: async (ruling) => void rulings.push(ruling),
    });
    const proxy = await startEgressProxy({ seam, port: 0, log: () => undefined });
    opened.push(proxy);
    const auth = basicOf(
      proxyUrlFor(proxy.port, { sessionId: 'ses_9', agent: 'codex-cli' }),
    );

    const answer = await get(proxy.port, `http://127.0.0.1:${port}/hello`, auth);
    expect(answer).toEqual({ status: 200, body: 'upstream says hi' });
    expect(rulings[0]?.caller).toEqual({ sessionId: 'ses_9', agent: 'codex-cli' });
  });

  it('refuses with the reason, so the refusal is not a dead end', async () => {
    const seam = new EgressSeam({
      authorizer: {
        authorize: async () => ({
          effect: DECISION_EFFECT.DENY,
          reason: 'not this host',
        }),
      } as unknown as HookAuthorizer,
    });
    const proxy = await startEgressProxy({ seam, port: 0, log: () => undefined });
    opened.push(proxy);
    const answer = await get(proxy.port, 'http://127.0.0.1:9/x', basicOf('http://a:b@h'));
    expect(answer.status).toBe(403);
    expect(answer.body).toContain('not this host');
  });

  it('says so when its port is taken, so the caller can take another', async () => {
    const seam = new EgressSeam({ authorizer: new HookAuthorizer({}) });
    const first = await startEgressProxy({ seam, port: 0, log: () => undefined });
    opened.push(first);
    await expect(
      startEgressProxy({ seam, port: first.port, log: () => undefined }),
    ).rejects.toThrow();
  });
});
