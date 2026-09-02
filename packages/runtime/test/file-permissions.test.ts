import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer, type MemnoxServer } from '../src/server';

const ADMIN = ['perm', 'admin', 'token'].join('-');
const SHARED_READ_BITS = 0o077;

/** Nothing is encrypted at rest, so owner-only file modes are the whole protection. */
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
      payload: {
        name: 'perm-probe',
        kind: 'claude-code',
        role: 'test-agent',
        principal: 'moise',
      },
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
      payload: {
        name: 'audit-probe',
        kind: 'claude-code',
        role: 'test-agent',
        principal: 'moise',
      },
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
