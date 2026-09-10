import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '@memnox/core';
import { OFFBOARD, ONBOARD, offboardAgent, onboardAgent } from '../src/agents/onboard';
import { readRecord } from '../src/agents/onboarding';
import { RecordedOutput } from '../src/cli-output';
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

/** The code and the link go to a person; a test only needs somewhere to put them. */
const out = () => new RecordedOutput();

/**
 * The control plane's half of the device flow: a code, then an approval already
 * granted. A person approving is the point of the flow and not what these
 * assertions are about.
 */
const deviceFlow = (url: string, counted: () => void): Response => {
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
