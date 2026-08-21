import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SILENT_LOGGER, type Logger } from '@memnox/core';
import { buildServer, type MemnoxServer } from '../src/server';
import { resolveKeyring } from '../src/keyring-loader';

const ADMIN = ['perm', 'admin', 'token'].join('-');
const OWNER_ONLY = 0o600;
const SHARED_READ_BITS = 0o077;

/** Encryption is off by default, so these files hold token hashes in the clear. */
describe('what the runtime leaves on disk', () => {
  let dataDir: string;
  let server: MemnoxServer;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-perms-'));
    server = await buildServer({ dataDir, adminToken: ADMIN });
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('writes the identity store owner-only', async () => {
    const registered = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: { name: 'perm-probe', kind: 'claude-code' },
    });
    expect(registered.statusCode).toBe(201);

    const info = await stat(join(dataDir, 'agents.json'));
    expect(info.mode & SHARED_READ_BITS).toBe(0);
  });

  it('writes the audit log owner-only', async () => {
    const registered = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: { name: 'audit-probe', kind: 'claude-code' },
    });
    const token = (registered.json() as { token: string }).token;
    await server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${token}` },
      payload: { action: 'repository.read' },
    });

    const info = await stat(join(dataDir, 'audit.jsonl'));
    expect(info.mode & SHARED_READ_BITS).toBe(0);
  });
});

describe('reading a keyring off disk', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memnox-keyring-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeKeyring(mode: number): Promise<string> {
    const path = join(dir, 'keyring.json');
    const keyring = {
      activeKeyId: 'k1',
      keys: [{ id: 'k1', secret: ['unit', 'secret'].join('-'), salt: 'unit-salt' }],
    };
    await writeFile(path, JSON.stringify(keyring), { encoding: 'utf8', mode });
    return path;
  }

  it('says so when other accounts can read the key', async () => {
    const path = await writeKeyring(0o644);
    const logger: Logger = { ...SILENT_LOGGER, warn: vi.fn<Logger['warn']>() };

    const keyring = await resolveKeyring({ keyringFile: path }, logger);

    expect(keyring).not.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('chmod 600'));
  });

  /** A warning on every start is a warning nobody reads. */
  it('stays quiet when the key is owner-only', async () => {
    const path = await writeKeyring(OWNER_ONLY);
    const logger: Logger = { ...SILENT_LOGGER, warn: vi.fn<Logger['warn']>() };

    await resolveKeyring({ keyringFile: path }, logger);

    expect(logger.warn).not.toHaveBeenCalled();
  });
});
