import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer, type MemnoxServer } from '../src/server';

const ADMIN = ['header', 'admin', 'token'].join('-');

/** Nothing here serves a page, so every directive stays at 'none'. */
describe('security headers', () => {
  let dataDir: string;
  let server: MemnoxServer;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-headers-'));
    server = await buildServer({ dataDir, adminToken: ADMIN });
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('refuses to be framed and refuses to be sniffed', async () => {
    const response = await server.app.inject({ method: 'GET', url: '/healthz' });
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('lets a JSON answer load nothing at all', async () => {
    const response = await server.app.inject({ method: 'GET', url: '/healthz' });
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['content-security-policy']).toContain(
      "frame-ancestors 'none'",
    );
  });
});
