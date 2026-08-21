import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer, type MemnoxServer } from '../src/server';

const ADMIN = ['header', 'admin', 'token'].join('-');

/** The console holds a management token; this is what stops another page using it. */
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

  it('runs the console by nonce and nothing else', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: '/',
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    const policy = String(response.headers['content-security-policy']);
    const nonce = /script-src 'nonce-([^']+)'/.exec(policy);
    expect(nonce).not.toBeNull();
    if (nonce === null) return;
    expect(response.body).toContain(`<script nonce="${nonce[1]}">`);
    expect(response.body).toContain(`<style nonce="${nonce[1]}">`);
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain('img-src data:');
    expect(policy).toContain("frame-ancestors 'none'");
    expect(response.headers['cache-control']).toBe('no-store');
  });

  /** A nonce reused across responses is a nonce an injected script can name. */
  it('mints a fresh nonce for every response', async () => {
    const nonces = new Set<string>();
    for (const _ of [0, 1, 2]) {
      const response = await server.app.inject({
        method: 'GET',
        url: '/',
        headers: { authorization: `Bearer ${ADMIN}` },
      });
      const found = /script-src 'nonce-([^']+)'/.exec(
        String(response.headers['content-security-policy']),
      );
      if (found !== null && found[1] !== undefined) nonces.add(found[1]);
    }
    expect(nonces.size).toBe(3);
  });

  /** A nonce covers `<style>`, not `style=""`, so inline attributes are dead markup. */
  it('carries no inline style attribute for the policy to block', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: '/',
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(response.body).not.toContain('style="');
  });

  /** The gate page collects a token, so it is the last page to run a stray script. */
  it('carries the same policy on the sign-in gate', async () => {
    const response = await server.app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-security-policy']).toContain("script-src 'nonce-");
    expect(response.headers['x-frame-options']).toBe('DENY');
  });
});
