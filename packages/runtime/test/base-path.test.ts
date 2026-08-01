import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer, normalizeBasePath, type MemnoxServer } from '../src/server';

const ADMIN = ['admin', 'token', 'value'].join('-');

/**
 * One runtime is one tenant, so a control plane reaching several of them behind
 * one host tells them apart by path. Without this the cloud's `<base>/<id>`
 * addresses 404 and every workspace reads as unreachable.
 */
describe('serving under a base path', () => {
  let dataDir: string;
  let server: MemnoxServer;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-base-path-'));
    server = await buildServer({ dataDir, adminToken: ADMIN, basePath: '/orbit' });
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const get = (url: string) =>
    server.app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${ADMIN}` },
    });

  it('answers the management routes under the prefix', async () => {
    expect((await get('/orbit/v1/policies')).statusCode).toBe(200);
    expect((await get('/orbit/v1/enforcement')).statusCode).toBe(200);
    expect((await get('/orbit/healthz')).statusCode).toBe(200);
  });

  it('stops answering them at the root, so tenants cannot be confused', async () => {
    expect((await get('/v1/policies')).statusCode).toBe(404);
    expect((await get('/v1/enforcement')).statusCode).toBe(404);
  });

  it('keeps /healthz at the root for an infrastructure probe', async () => {
    expect((await get('/healthz')).statusCode).toBe(200);
  });

  it('still decides actions under the prefix', async () => {
    const registration = await server.app.inject({
      method: 'POST',
      url: '/orbit/v1/agents',
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: { name: 'claude-code', kind: 'claude-code' },
    });
    expect(registration.statusCode).toBe(201);
    const { token } = registration.json() as { token: string };

    const decision = await server.app.inject({
      method: 'POST',
      url: '/orbit/v1/actions/check',
      headers: { authorization: `Bearer ${token}` },
      payload: { action: 'file.read', environment: 'production' },
    });
    expect(decision.statusCode).toBe(200);
  });
});

describe('normalizeBasePath', () => {
  it('accepts a prefix however it was written', () => {
    expect(normalizeBasePath('orbit')).toBe('/orbit');
    expect(normalizeBasePath('/orbit')).toBe('/orbit');
    expect(normalizeBasePath('/orbit/')).toBe('/orbit');
  });

  it('reads nothing as the root', () => {
    expect(normalizeBasePath(undefined)).toBe('');
    expect(normalizeBasePath('')).toBe('');
    expect(normalizeBasePath('  ')).toBe('');
    expect(normalizeBasePath('/')).toBe('');
  });
});
