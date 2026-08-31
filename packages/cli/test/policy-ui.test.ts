import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POLICY_DOCUMENT_VERSION, type PolicyDocument } from '@memnox/policy-engine';
import {
  createPolicyUiHandler,
  type PolicyUiHandler,
  type PolicyUiRequest,
  type SimulationReport,
} from '../src/policy-ui/policy-ui-app';
import { loopbackPolicyUi } from '../src/policy-ui/policy-ui-server';
import { UI_PATH, UI_SESSION_HEADER } from '../src/policy-ui/policy-ui.constants';
import {
  registerPolicyUiCommand,
  type PolicyUiHost,
} from '../src/commands/policy-ui.command';
import { FakeRuntime, runCommand } from './cli-harness';

const TOKEN = 'a-session-token-minted-for-this-run';
const UNREACHABLE: SimulationReport = { available: false, reason: 'no runtime' };

const approvalRule = {
  name: 'production-deploy-approval',
  match: { actions: ['deploy.*'] },
  decision: { effect: 'escalate', approvers: ['eng-lead'] },
};

function request(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string | undefined> = {},
): PolicyUiRequest {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:7391', [UI_SESSION_HEADER]: TOKEN, ...headers },
    body: body === undefined ? '' : JSON.stringify(body),
  };
}

interface Harness {
  handle: PolicyUiHandler;
  written: PolicyDocument[];
  errors: string[];
}

function harness(
  document: PolicyDocument = { version: POLICY_DOCUMENT_VERSION, policies: [] },
  simulate: () => Promise<SimulationReport> = async () => UNREACHABLE,
): Harness {
  const written: PolicyDocument[] = [];
  const errors: string[] = [];
  return {
    written,
    errors,
    handle: createPolicyUiHandler({
      filePath: 'memnox.policies.yaml',
      sessionToken: TOKEN,
      read: async () => document,
      write: async (next) => {
        written.push(next);
      },
      simulate,
      onError: (message) => errors.push(message),
    }),
  };
}

const bodyOf = (response: { body: string }): Record<string, unknown> =>
  JSON.parse(response.body) as Record<string, unknown>;

describe('policy editor server', () => {
  it('serves the editor page on the root path', async () => {
    const response = await harness().handle(request('GET', UI_PATH.PAGE));

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('Policy editor');
  });

  /** The editor ships as a string, so nothing else would catch a syntax error in it. */
  it('embeds a client script a browser can parse', async () => {
    const page = (await harness().handle(request('GET', UI_PATH.PAGE))).body;
    const script = page.slice(
      page.indexOf('<script>') + '<script>'.length,
      page.lastIndexOf('</script>'),
    );

    expect(script).toContain('function boot()');
    expect(() => new Function(script)).not.toThrow();
  });

  it('refuses a request that arrived under some other hostname', async () => {
    const response = await harness().handle(
      request('GET', UI_PATH.PAGE, undefined, { host: 'rebound.example.com' }),
    );

    expect(response.status).toBe(403);
  });

  it('refuses an api call that does not carry the session token', async () => {
    const response = await harness().handle(
      request('GET', UI_PATH.DOCUMENT, undefined, { [UI_SESSION_HEADER]: undefined }),
    );

    expect(response.status).toBe(403);
  });

  it('refuses an api call carrying the wrong session token', async () => {
    const response = await harness().handle(
      request('GET', UI_PATH.DOCUMENT, undefined, {
        [UI_SESSION_HEADER]: TOKEN.replace('a-session', 'b-session'),
      }),
    );

    expect(response.status).toBe(403);
  });

  it('hands the page the rules that are in the file', async () => {
    const document = {
      version: POLICY_DOCUMENT_VERSION,
      project: 'acme',
      policies: [approvalRule],
    } as unknown as PolicyDocument;

    const response = await harness(document).handle(request('GET', UI_PATH.DOCUMENT));

    expect(bodyOf(response)['document']).toEqual(document);
  });

  it('reports what is wrong with a rule instead of failing the request', async () => {
    const response = await harness().handle(
      request('POST', UI_PATH.VALIDATE, {
        policies: [{ ...approvalRule, decision: { effect: 'escalate' } }],
      }),
    );

    expect(response.status).toBe(200);
    expect(bodyOf(response)['valid']).toBe(false);
    expect(String(bodyOf(response)['issues'])).toContain('approvers is required');
  });

  it('previews the exact YAML a save would write', async () => {
    const response = await harness().handle(
      request('POST', UI_PATH.VALIDATE, { project: 'acme', policies: [approvalRule] }),
    );

    const payload = bodyOf(response);
    expect(payload['valid']).toBe(true);
    expect(String(payload['yaml'])).toContain('project: acme');
    expect(String(payload['yaml'])).toContain('production-deploy-approval');
    expect(payload['policyCount']).toBe(1);
  });

  it('writes the document, project and all, when the rules are valid', async () => {
    const test = harness();

    const response = await test.handle(
      request('POST', UI_PATH.SAVE, { project: 'acme', policies: [approvalRule] }),
    );

    expect(bodyOf(response)['saved']).toBe(true);
    expect(test.written).toHaveLength(1);
    expect(test.written[0]?.project).toBe('acme');
    expect(test.written[0]?.policies[0]?.name).toBe('production-deploy-approval');
  });

  it('never writes a rule set the validator rejected', async () => {
    const test = harness();

    const response = await test.handle(
      request('POST', UI_PATH.SAVE, { policies: [{ name: 'no-match-block' }] }),
    );

    expect(response.status).toBe(400);
    expect(test.written).toEqual([]);
  });

  it('reports a failed write rather than telling the page it saved', async () => {
    const errors: string[] = [];
    const handle = createPolicyUiHandler({
      filePath: 'memnox.policies.yaml',
      sessionToken: TOKEN,
      read: async () => ({ version: POLICY_DOCUMENT_VERSION, policies: [] }),
      write: async () => {
        throw new Error('EACCES: permission denied');
      },
      simulate: async () => UNREACHABLE,
      onError: (message) => errors.push(message),
    });

    const response = await handle(
      request('POST', UI_PATH.SAVE, { policies: [approvalRule] }),
    );

    expect(response.status).toBe(500);
    expect(bodyOf(response)['saved']).toBe(false);
    expect(errors[0]).toContain('permission denied');
  });

  it('merges a pack into the rules being edited without saving them', async () => {
    const test = harness();

    const response = await test.handle(
      request('POST', UI_PATH.PACK, { pack: 'production-safety', policies: [] }),
    );

    const payload = bodyOf(response);
    expect((payload['added'] as string[]).length).toBeGreaterThan(0);
    expect(test.written).toEqual([]);
  });

  it('rejects a pack nobody ships', async () => {
    const response = await harness().handle(
      request('POST', UI_PATH.PACK, { pack: 'not-a-pack', policies: [] }),
    );

    expect(response.status).toBe(400);
  });

  it('passes an unreachable runtime through to the simulate panel', async () => {
    const response = await harness().handle(
      request('POST', UI_PATH.SIMULATE, { policies: [approvalRule] }),
    );

    expect(bodyOf(response)['available']).toBe(false);
  });

  it('answers an unknown route without leaking the page', async () => {
    const response = await harness().handle(request('GET', '/api/nope'));

    expect(response.status).toBe(404);
  });
});

describe('the loopback server', () => {
  it('serves the page and the api over a real socket', async () => {
    const test = harness();
    const session = await loopbackPolicyUi(test.handle, 0);

    const page = await fetch(session.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Policy editor');

    const saved = await fetch(`${session.url}${UI_PATH.SAVE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [UI_SESSION_HEADER]: TOKEN },
      body: JSON.stringify({ policies: [approvalRule] }),
    });
    expect(saved.status).toBe(200);
    expect(test.written[0]?.policies[0]?.name).toBe('production-deploy-approval');

    await session.stop();
    await session.finished;
  });

  it('turns away a browser that reached it without the session token', async () => {
    const session = await loopbackPolicyUi(harness().handle, 0);

    const response = await fetch(`${session.url}${UI_PATH.DOCUMENT}`);

    expect(response.status).toBe(403);
    await session.stop();
  });
});

describe('memnox policy ui', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memnox-policy-ui-'));
    file = join(dir, 'memnox.policies.yaml');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  interface FakeHost {
    host: PolicyUiHost;
    opened: string[];
    ports: number[];
    handler(): PolicyUiHandler;
  }

  function fakeHost(): FakeHost {
    const opened: string[] = [];
    const ports: number[] = [];
    let captured: PolicyUiHandler | null = null;
    return {
      opened,
      ports,
      handler: () => {
        if (captured === null) throw new Error('the command never launched a server');
        return captured;
      },
      host: {
        sessionToken: () => TOKEN,
        open: async (url) => {
          opened.push(url);
        },
        launch: async (handle, port) => {
          captured = handle;
          ports.push(port);
          return {
            url: `http://127.0.0.1:${port}`,
            finished: Promise.resolve(),
            stop: async () => undefined,
          };
        },
      },
    };
  }

  const run = async (host: PolicyUiHost, args: string[], runtime = new FakeRuntime()) =>
    runCommand(
      (program, context) => registerPolicyUiCommand(program, context, host),
      args,
      runtime,
    );

  it('prints the loopback URL and opens a browser at it', async () => {
    const fake = fakeHost();

    const { out } = await run(fake.host, ['ui', '--file', file, '--port', '7391']);

    expect(out.text).toBe('http://127.0.0.1:7391');
    expect(fake.opened).toEqual(['http://127.0.0.1:7391']);
  });

  it('leaves the browser alone when asked to', async () => {
    const fake = fakeHost();

    await run(fake.host, ['ui', '--file', file, '--no-open']);

    expect(fake.opened).toEqual([]);
  });

  it('says which file it is editing and that saving rewrites it', async () => {
    const fake = fakeHost();

    const { out } = await run(fake.host, ['ui', '--file', file, '--no-open']);

    expect(out.notes.join('\n')).toContain(file);
    expect(out.notes.join('\n')).toContain('comments in it are not carried over');
  });

  it('starts on an empty rule set when the file does not exist yet', async () => {
    const fake = fakeHost();
    await run(fake.host, ['ui', '--file', file, '--no-open']);

    const response = await fake.handler()(request('GET', UI_PATH.DOCUMENT));

    expect(bodyOf(response)['document']).toEqual({
      version: POLICY_DOCUMENT_VERSION,
      policies: [],
    });
  });

  it('saves the edited rules to the policy file', async () => {
    const fake = fakeHost();
    await run(fake.host, ['ui', '--file', file, '--no-open']);

    await fake.handler()(request('POST', UI_PATH.SAVE, { policies: [approvalRule] }));

    expect(await readFile(file, 'utf8')).toContain('production-deploy-approval');
  });

  it('replays real audit history against the rules being edited', async () => {
    await writeFile(
      file,
      `version: 1\npolicies:\n  - name: allow-deploys\n    match: { actions: ["deploy.*"] }\n    decision: { effect: allow }\n`,
      'utf8',
    );
    const runtime = new FakeRuntime().on('GET', '/v1/audit', [
      { action: 'deploy.production', environment: 'production', agentName: 'claude' },
    ]);
    const fake = fakeHost();
    await run(fake.host, ['ui', '--file', file, '--no-open'], runtime);

    const response = await fake.handler()(
      request('POST', UI_PATH.SIMULATE, {
        policies: [
          {
            name: 'allow-deploys',
            match: { actions: ['deploy.*'] },
            decision: { effect: 'withhold', reason: 'not from an agent' },
          },
        ],
      }),
    );

    const payload = bodyOf(response);
    expect(payload['available']).toBe(true);
    expect(payload['changes']).toHaveLength(1);
    expect((payload['changes'] as { after: string }[])[0]?.after).toBe('withhold');
  });

  it('tells the panel why it cannot replay when no runtime answers', async () => {
    const fake = fakeHost();
    await run(fake.host, ['ui', '--file', file, '--no-open']);

    const response = await fake.handler()(
      request('POST', UI_PATH.SIMULATE, { policies: [approvalRule] }),
    );

    const payload = bodyOf(response);
    expect(payload['available']).toBe(false);
    expect(String(payload['reason'])).toContain('memnox serve');
  });
});
