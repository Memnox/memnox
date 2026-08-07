import { mkdtemp, rm, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAgentConfig, writeAgentConfig } from '../src/agent-config';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import type { CloudClient, CloudIdentity } from '../src/cloud-client';
import { ENV_CLOUD_TOKEN, ENV_CLOUD_URL } from '../src/cloud-connection';
import { registerCloudCommand } from '../src/commands/cloud.command';
import { registerLoginCommand } from '../src/commands/login.command';
import { plainStyle } from '../src/style';

const CLOUD_URL = 'https://cloud.acme.test';
const CLOUD_TOKEN = 'mnc_developer';
const IDENTITY: CloudIdentity = { name: 'ana', role: 'reviewer' };
const ENV_VARS = [ENV_CLOUD_URL, ENV_CLOUD_TOKEN, 'MEMNOX_CLOUD_WORKSPACE'];

describe('memnox login', () => {
  let home: string;
  let out: RecordedOutput;
  let saved: Record<string, string | undefined>;
  let identityCalls: number;
  let failMe: boolean;
  let browsed: string[];
  let exchanged: { code: string; verifier: string; label: string }[];

  // Plays the control plane's browser leg: reads the callback the CLI is
  // listening on and redirects back to it, exactly as a 302 would.
  const opener = async (url: string): Promise<void> => {
    browsed.push(url);
    const params = new URL(url).searchParams;
    const back = new URL(params.get('redirect_uri') ?? '');
    back.searchParams.set('code', 'browser-code');
    back.searchParams.set('state', params.get('state') ?? '');
    await fetch(back.toString()).catch(() => undefined);
  };

  const exchange = async (
    _cloudUrl: string,
    code: string,
    verifier: string,
    label: string,
  ): Promise<{ token: string; name: string; role: string; orgId: string }> => {
    exchanged.push({ code, verifier, label });
    return { token: CLOUD_TOKEN, name: 'ana', role: 'reviewer', orgId: 'acme' };
  };

  const fakeClient = (): CloudClient =>
    ({
      me: async () => {
        identityCalls += 1;
        if (failMe) throw new Error('unauthorized');
        return IDENTITY;
      },
      suggestions: async () => [],
      timeline: async () => [],
    }) as unknown as CloudClient;

  const run = async (args: string[]): Promise<void> => {
    const program = new Command();
    program.exitOverride();
    const context = new CliContext(out, undefined, plainStyle);
    registerLoginCommand(program, context, home, fakeClient, opener, exchange);
    registerCloudCommand(program, context, home, fakeClient);
    await program.parseAsync(args, { from: 'user' });
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'memnox-login-'));
    out = new RecordedOutput();
    identityCalls = 0;
    failMe = false;
    browsed = [];
    exchanged = [];
    saved = {};
    for (const name of ENV_VARS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(async () => {
    for (const name of ENV_VARS) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    process.exitCode = undefined;
    await rm(home, { recursive: true, force: true });
  });

  it('stores the credential once the control plane has confirmed it', async () => {
    await run([
      'login',
      '--cloud',
      CLOUD_URL,
      '--token',
      CLOUD_TOKEN,
      '--workspace',
      'orbit',
    ]);

    expect(identityCalls).toBe(1);
    const stored = await readAgentConfig(home);
    expect(stored.cloud).toEqual({
      url: CLOUD_URL,
      token: CLOUD_TOKEN,
      workspace: 'orbit',
    });
    expect(out.text).toContain('Signed in to');
  });

  it('verifies before writing, so a bad token never lands on disk', async () => {
    failMe = true;

    await expect(
      run(['login', '--cloud', CLOUD_URL, '--token', 'wrong']),
    ).rejects.toThrow();

    expect((await readAgentConfig(home)).cloud).toBeUndefined();
  });

  it('stores nothing when nobody finishes signing in', async () => {
    // The browser never comes back: no credential, and no half-written config.
    const program = new Command();
    program.exitOverride();
    registerLoginCommand(
      program,
      new CliContext(out, undefined, plainStyle),
      home,
      fakeClient,
      async (url: string) => {
        const params = new URL(url).searchParams;
        const back = new URL(params.get('redirect_uri') ?? '');
        back.searchParams.set('error', 'access_denied');
        back.searchParams.set('state', params.get('state') ?? '');
        await fetch(back.toString()).catch(() => undefined);
      },
      exchange,
    );
    await program.parseAsync(['login', '--cloud', CLOUD_URL], { from: 'user' });

    expect((await readAgentConfig(home)).cloud).toBeUndefined();
    expect(exchanged).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it('keeps the agent token owner-only when it rewrites the file', async () => {
    await writeAgentConfig(home, { token: 'mnx_agent', url: 'http://127.0.0.1:7466' });

    await run(['login', '--cloud', CLOUD_URL, '--token', CLOUD_TOKEN]);

    const stored = await readAgentConfig(home);
    expect(stored.token).toBe('mnx_agent');
    const mode = (await stat(join(home, '.memnox', 'config.json'))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('opens a browser and stores what the exchange returned, with no token typed', async () => {
    await run(['login', '--cloud', CLOUD_URL, '--workspace', 'orbit']);

    expect(browsed[0]).toContain('/v1/auth/cli');
    expect(exchanged[0]?.code).toBe('browser-code');
    expect((await readAgentConfig(home)).cloud?.token).toBe(CLOUD_TOKEN);
  });

  it('labels the credential with this machine, so it can be revoked by name', async () => {
    await run(['login', '--cloud', CLOUD_URL]);

    expect(exchanged[0]?.label).toContain(hostname());
  });

  it('sends only the challenge to the browser, never the verifier', async () => {
    await run(['login', '--cloud', CLOUD_URL]);

    const sent = new URL(browsed[0] ?? '').searchParams.get('code_challenge');
    expect(sent).not.toBe(exchanged[0]?.verifier);
    expect(new URL(browsed[0] ?? '').searchParams.get('code_challenge_method')).toBe(
      'S256',
    );
  });

  it('skips the browser entirely when a token is supplied', async () => {
    await run(['login', '--cloud', CLOUD_URL, '--token', CLOUD_TOKEN]);

    expect(browsed).toEqual([]);
    expect(exchanged).toEqual([]);
  });

  it('signs out without disarming the local runtime', async () => {
    await writeAgentConfig(home, {
      token: 'mnx_agent',
      url: 'http://127.0.0.1:7466',
      cloud: { url: CLOUD_URL, token: CLOUD_TOKEN },
    });

    await run(['logout']);

    const stored = await readAgentConfig(home);
    expect(stored.cloud).toBeUndefined();
    // Leaving the org must not stop this machine being governed.
    expect(stored.token).toBe('mnx_agent');
  });

  it('says so when logging out while signed out', async () => {
    await run(['logout']);

    expect(out.text).toContain('Not signed in');
  });

  it('reports both connections in whoami', async () => {
    await writeAgentConfig(home, {
      token: 'mnx_agent',
      url: 'http://127.0.0.1:9000',
      cloud: { url: CLOUD_URL, token: CLOUD_TOKEN, workspace: 'orbit' },
    });

    await run(['whoami']);

    expect(out.text).toContain('http://127.0.0.1:9000');
    expect(out.text).toContain(CLOUD_URL);
    expect(out.text).toContain('ana');
    expect(out.text).toContain('orbit');
  });

  it('whoami still describes the runtime when no org is joined', async () => {
    await writeAgentConfig(home, { token: 'mnx_agent', url: 'http://127.0.0.1:9000' });

    await run(['whoami']);

    expect(out.text).toContain('not signed in');
    expect(identityCalls).toBe(0);
  });
});
