import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '@memnox/core';
import { OFFBOARD, ONBOARD, offboardAgent, onboardAgent } from '../src/agents/onboard';
import { readRecord } from '../src/agents/onboarding';
import type { EnrolReporter } from '../src/agents/enrol-agent';
import {
  MANAGED_SERVER,
  withManagedServer,
  withoutManagedServer,
} from '../src/agents/managed-server';

/**
 * Putting an agent under Memnox, and taking it back out.
 *
 * The rewrite is the easy half. The backup and the record are what make
 * offboarding an undo rather than a second guess at what the file used to say.
 */

const BASE = 'https://cloud.memnox.test';
const AGENT = 'agt_cursor';

const account: Account = {
  version: 1,
  baseUrl: BASE,
  workspaceId: 'acme',
  machineId: 'mch_host',
  token: 'machine-token',
  privateKey: 'unused',
  enrolledAt: '2026-09-05T10:00:00.000Z',
};

/** What enrolment said while it ran. A test only needs somewhere to put it. */
interface Said extends EnrolReporter {
  readonly lines: string[];
  /** Whether a person was sent to a browser, which is the thing under test. */
  readonly browsed: boolean;
}

const out = (): Said => {
  const lines: string[] = [];
  let browsed = false;
  return {
    lines,
    get browsed() {
      return browsed;
    },
    approve: ({ what, url, because }) => {
      browsed = true;
      lines.push(`approve ${what} at ${url}: ${because}`);
    },
  };
};

/**
 * The control plane's half.
 *
 * The sponsored door first, because that is the one an enrolment takes when the
 * machine already holds a credential. The device flow behind it is what a
 * control plane too old for that route leaves, and `noSponsoredDoor` is how a
 * test asks for exactly that.
 */
const deviceFlow = (url: string, counted: () => void): Response => {
  if (url.endsWith(`/machines/${account.machineId}/agents`)) {
    counted();
    return new Response(
      JSON.stringify({
        id: 'mch_agent_1',
        token: 'mch_agent_secret',
        connection: 'mcp',
        mode: 'observe',
        mcpUrl: `${BASE}/v1/workspaces/acme/mcp`,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  if (url.endsWith('/v1/device/codes')) {
    counted();
    return new Response(
      JSON.stringify({
        deviceCode: 'dev-1',
        userCode: 'ABCD-1234',
        intervalSeconds: 0,
        expiresAt: Date.now() + 60_000,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  if (url.endsWith('/v1/device/tokens')) {
    return new Response(
      JSON.stringify({
        machineId: 'mch_agent_1',
        token: 'mch_agent_secret',
        mode: 'observe',
        workspaceId: 'acme',
        mcpUrl: `${BASE}/v1/workspaces/acme/mcp`,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

/** A control plane too old for the sponsored door, which answers 404 for it. */
const noSponsoredDoor = (url: string): Response =>
  url.endsWith('/agents')
    ? new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
    : deviceFlow(url, () => undefined);

const ORIGINAL = {
  mcpServers: {
    'next-devtools': { command: 'npx', args: ['next-devtools-mcp'] },
  },
  // A key Memnox knows nothing about, which must survive untouched.
  editor: { theme: 'dark' },
};

describe('onboarding an agent', () => {
  let home: string;
  let enrolments: number;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'memnox-onboard-'));
    await mkdir(join(home, '.cursor'), { recursive: true });
    await writeFile(
      join(home, '.cursor', 'mcp.json'),
      `${JSON.stringify(ORIGINAL, null, 2)}\n`,
      'utf8',
    );
    enrolments = 0;
    vi.stubGlobal('fetch', (async (url: URL | string) =>
      deviceFlow(String(url), () => (enrolments += 1))) as typeof fetch);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(home, { recursive: true, force: true });
  });

  const config = () => readFile(join(home, '.cursor', 'mcp.json'), 'utf8');

  it('writes the Memnox server into the agent own config', async () => {
    const result = await onboardAgent(home, home, account, AGENT, 'cursor', out());

    expect(result.outcome).toBe(ONBOARD.DONE);
    const written = JSON.parse(await config());
    expect(written.mcpServers[MANAGED_SERVER]).toMatchObject({
      type: 'http',
      url: `${BASE}/v1/workspaces/acme/mcp`,
    });
  });

  it('keeps everything it does not own', async () => {
    /* Losing an agent's own servers or its editor settings would be a far worse
       outcome than not onboarding at all. */
    await onboardAgent(home, home, account, AGENT, 'cursor', out());

    const written = JSON.parse(await config());
    expect(written.mcpServers['next-devtools']).toEqual(
      ORIGINAL.mcpServers['next-devtools'],
    );
    expect(written.editor).toEqual({ theme: 'dark' });
  });

  it('backs the config up before it writes, verbatim', async () => {
    const result = await onboardAgent(home, home, account, AGENT, 'cursor', out());
    const backup = await readFile(result.record?.backupPath ?? '', 'utf8');

    expect(JSON.parse(backup)).toEqual(ORIGINAL);
  });

  it('mints one credential per agent, not per host', async () => {
    /* Two agents on one laptop are two machines, so revoking one does not
       silence the other. */
    await onboardAgent(home, home, account, AGENT, 'cursor', out());

    expect(enrolments).toBe(1);
  });

  it('enrols on the credential this machine already holds, with no browser', async () => {
    /* A person approved this laptop once. Asking them again per agent is the
       same decision put five times, and the fifth answer never comes. */
    const said = out();
    const result = await onboardAgent(home, home, account, AGENT, 'cursor', said);

    expect(result.outcome).toBe(ONBOARD.DONE);
    expect(result.approvedInBrowser).toBe(false);
    expect(said.browsed).toBe(false);
  });

  it('asks a person where the control plane has no door for a machine', async () => {
    /* Somebody upgrading their laptop ahead of their cloud must not be stopped,
       so a 404 on that route is a fallback rather than a failure. */
    vi.stubGlobal('fetch', (async (url: URL | string) =>
      noSponsoredDoor(String(url))) as typeof fetch);

    const said = out();
    const result = await onboardAgent(home, home, account, AGENT, 'cursor', said);

    expect(result.outcome).toBe(ONBOARD.DONE);
    expect(result.approvedInBrowser).toBe(true);
    expect(said.browsed).toBe(true);
  });

  it('says why a browser opened, rather than opening one unannounced', async () => {
    vi.stubGlobal('fetch', (async (url: URL | string) =>
      noSponsoredDoor(String(url))) as typeof fetch);

    const said = out();
    await onboardAgent(home, home, account, AGENT, 'cursor', said);

    expect(said.lines.join('\n')).toContain('without a person');
  });

  it('leaves the config alone where enrolment fails', async () => {
    /* The credential is minted first for exactly this: a failure must not leave
       a rewritten config pointing at nothing. */
    vi.stubGlobal(
      'fetch',
      (async () => new Response('{}', { status: 403 })) as typeof fetch,
    );

    const before = await config();
    const result = await onboardAgent(home, home, account, AGENT, 'cursor', out());

    expect(result.outcome).toBe(ONBOARD.FAILED);
    expect(await config()).toBe(before);
    expect(await readRecord(home, AGENT)).toBeNull();
  });

  it('says so rather than rewriting a config it could not read back', async () => {
    await writeFile(join(home, '.cursor', 'mcp.json'), 'not json at all', 'utf8');

    const result = await onboardAgent(home, home, account, AGENT, 'cursor', out());

    expect(result.outcome).toBe(ONBOARD.UNSUPPORTED);
    expect(await config()).toBe('not json at all');
  });

  it('says so where this machine keeps no config for that agent', async () => {
    const result = await onboardAgent(home, home, account, 'agt_hermes', 'hermes', out());

    expect(result.outcome).toBe(ONBOARD.NOT_FOUND);
  });
});

describe('offboarding an agent', () => {
  let home: string;
  let revoked: string[];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'memnox-offboard-'));
    await mkdir(join(home, '.cursor'), { recursive: true });
    await writeFile(
      join(home, '.cursor', 'mcp.json'),
      `${JSON.stringify(ORIGINAL, null, 2)}\n`,
      'utf8',
    );
    revoked = [];
    vi.stubGlobal('fetch', (async (url: URL | string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        revoked.push(String(url));
        return new Response('{}', { status: 200 });
      }
      return deviceFlow(String(url), () => undefined);
    }) as typeof fetch);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(home, { recursive: true, force: true });
  });

  const config = () => readFile(join(home, '.cursor', 'mcp.json'), 'utf8');

  it('puts the config back exactly as it was', async () => {
    await onboardAgent(home, home, account, AGENT, 'cursor', out());
    const result = await offboardAgent(home, account, AGENT);

    expect(result.outcome).toBe(OFFBOARD.DONE);
    expect(result.restoredFromBackup).toBe(true);
    expect(JSON.parse(await config())).toEqual(ORIGINAL);
  });

  it('takes the credential away, not only the configuration', async () => {
    /* Restoring the config and leaving a live credential would take the agent's
       settings away and leave its reach. */
    await onboardAgent(home, home, account, AGENT, 'cursor', out());
    const result = await offboardAgent(home, account, AGENT);

    expect(result.revoked).toBe(true);
    expect(revoked[0]).toContain('mch_agent_1');
  });

  it('stops reading as onboarded afterwards', async () => {
    await onboardAgent(home, home, account, AGENT, 'cursor', out());
    await offboardAgent(home, account, AGENT);

    expect(await readRecord(home, AGENT)).toBeNull();
  });

  it('removes only the Memnox entry where the backup has gone', async () => {
    /* A weaker undo, and it is reported as one: anything a person changed since
       stays rather than being reverted. */
    const onboarded = await onboardAgent(home, home, account, AGENT, 'cursor', out());
    await rm(onboarded.record?.backupPath ?? '', { force: true });

    const result = await offboardAgent(home, account, AGENT);

    expect(result.restoredFromBackup).toBe(false);
    const written = JSON.parse(await config());
    expect(written.mcpServers[MANAGED_SERVER]).toBeUndefined();
    expect(written.mcpServers['next-devtools']).toBeDefined();
  });

  it('says so for an agent that was never onboarded', async () => {
    const result = await offboardAgent(home, account, 'agt_never');

    expect(result.outcome).toBe(OFFBOARD.NOT_ONBOARDED);
  });
});

/**
 * The two formats that are not JSON, through the real onboard and offboard.
 *
 * Codex and Hermes are two of the six agent kinds on an ordinary laptop, and
 * while onboarding declined anything that was not JSON they were agents Memnox
 * could find and could not govern.
 */
describe('onboarding an agent that does not keep JSON', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'memnox-formats-'));
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(
      join(home, '.codex', 'config.toml'),
      '# mine\nmodel = "o3"\n\n[mcp_servers.node_repl]\ncommand = "node"\n',
      'utf8',
    );
    await mkdir(join(home, '.hermes'), { recursive: true });
    await writeFile(
      join(home, '.hermes', 'config.yaml'),
      '# mine\nruntime: node\n\nmcp_servers:\n  notes:\n    command: notes-mcp\n',
      'utf8',
    );
    vi.stubGlobal('fetch', (async (url: URL | string) =>
      deviceFlow(String(url), () => undefined)) as typeof fetch);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(home, { recursive: true, force: true });
  });

  it('puts the entry into a Codex TOML config', async () => {
    const result = await onboardAgent(
      home,
      home,
      account,
      'agt_codex-cli',
      'codex-cli',
      out(),
    );

    expect(result.outcome).toBe(ONBOARD.DONE);
    const written = await readFile(join(home, '.codex', 'config.toml'), 'utf8');
    expect(written).toContain(`[mcp_servers.${MANAGED_SERVER}]`);
    // What was already there, including the comment somebody wrote.
    expect(written).toContain('[mcp_servers.node_repl]');
    expect(written).toContain('# mine');
  });

  it('puts the entry into a Hermes YAML config', async () => {
    const result = await onboardAgent(home, home, account, 'agt_hermes', 'hermes', out());

    expect(result.outcome).toBe(ONBOARD.DONE);
    const written = await readFile(join(home, '.hermes', 'config.yaml'), 'utf8');
    expect(written).toContain(MANAGED_SERVER);
    expect(written).toContain('notes');
    expect(written).toContain('# mine');
  });

  it('puts a TOML config back exactly as it was', async () => {
    /* The backup is the honest undo for every format, because it restores the
       bytes rather than reconstructing what they might have been. */
    const before = await readFile(join(home, '.codex', 'config.toml'), 'utf8');
    await onboardAgent(home, home, account, 'agt_codex-cli', 'codex-cli', out());

    await offboardAgent(home, account, 'agt_codex-cli');

    expect(await readFile(join(home, '.codex', 'config.toml'), 'utf8')).toBe(before);
  });

  it('puts a YAML config back exactly as it was', async () => {
    const before = await readFile(join(home, '.hermes', 'config.yaml'), 'utf8');
    await onboardAgent(home, home, account, 'agt_hermes', 'hermes', out());

    await offboardAgent(home, account, 'agt_hermes');

    expect(await readFile(join(home, '.hermes', 'config.yaml'), 'utf8')).toBe(before);
  });

  it('removes only its own entry where the backup has gone', async () => {
    const onboarded = await onboardAgent(
      home,
      home,
      account,
      'agt_codex-cli',
      'codex-cli',
      out(),
    );
    await rm(onboarded.record?.backupPath ?? '', { force: true });

    const result = await offboardAgent(home, account, 'agt_codex-cli');

    expect(result.restoredFromBackup).toBe(false);
    const written = await readFile(join(home, '.codex', 'config.toml'), 'utf8');
    expect(written).not.toContain(`[mcp_servers.${MANAGED_SERVER}]`);
    expect(written).toContain('[mcp_servers.node_repl]');
  });

  it('says so rather than rewriting a TOML config it could not read back', async () => {
    await writeFile(join(home, '.codex', 'config.toml'), 'not toml at all [[[', 'utf8');

    const result = await onboardAgent(
      home,
      home,
      account,
      'agt_codex-cli',
      'codex-cli',
      out(),
    );

    expect(result.outcome).toBe(ONBOARD.UNSUPPORTED);
    expect(await readFile(join(home, '.codex', 'config.toml'), 'utf8')).toBe(
      'not toml at all [[[',
    );
  });
});

describe('the managed entry itself', () => {
  it('replaces its own entry rather than leaving two', async () => {
    const once = withManagedServer(JSON.stringify(ORIGINAL), 'mcpServers', {
      type: 'http',
      url: 'a',
      headers: {},
    });
    const twice = withManagedServer(once.next ?? '', 'mcpServers', {
      type: 'http',
      url: 'b',
      headers: {},
    });

    const written = JSON.parse(twice.next ?? '');
    expect(written.mcpServers[MANAGED_SERVER].url).toBe('b');
    expect(Object.keys(written.mcpServers)).toHaveLength(2);
  });

  it('leaves a config that never had one untouched', async () => {
    const raw = `${JSON.stringify(ORIGINAL, null, 2)}\n`;

    expect(withoutManagedServer(raw, 'mcpServers').next).toBe(raw);
  });
});
