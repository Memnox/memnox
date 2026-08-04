import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ENFORCEMENT_MODE } from '@memnox/core';
import { buildServer, type MemnoxServer } from '../src/server';
import { escapeHtml, renderDashboard } from '../src/routes/dashboard-page';
import type { RuntimeStatus } from '../src/runtime-status';

const ADMIN = ['admin', 'token', 'value'].join('-');

const STATUS: RuntimeStatus = {
  enforcement: ENFORCEMENT_MODE.MONITOR,
  policyCount: 10,
  policyVersion: 'e852ac2d63d0',
  pendingApprovals: 1,
  recentDecisions: 214,
  withheld: 9,
  guards: ['content shield', 'taint'],
  recent: [],
};

/**
 * Opening the address `memnox setup` prints used to return a 404 body, which is
 * what someone following the getting-started page actually saw.
 */
describe('the dashboard at /', () => {
  let dataDir: string;
  let server: MemnoxServer;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-dashboard-'));
    server = await buildServer({ dataDir, adminToken: ADMIN });
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('serves HTML instead of a 404', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: '/',
      headers: { authorization: `Bearer ${ADMIN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('<!doctype html>');
    expect(response.body).toContain('Memnox');
  });

  it('offers the same numbers as JSON', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: '/v1/status',
      headers: { authorization: `Bearer ${ADMIN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      enforcement: expect.any(String),
      policyCount: expect.any(Number),
      guards: expect.any(Array),
    });
  });

  it('does not serve the audit trail to an unauthenticated caller', async () => {
    // A runtime with keys must not hand its decisions to whoever finds the port.
    expect((await server.app.inject({ method: 'GET', url: '/' })).statusCode).toBe(401);
    expect(
      (await server.app.inject({ method: 'GET', url: '/v1/status' })).statusCode,
    ).toBe(401);
  });
});

describe('rendering the page', () => {
  it('names the mode so observing is never mistaken for enforcing', () => {
    expect(renderDashboard(STATUS)).toContain('observing');
    expect(
      renderDashboard({ ...STATUS, enforcement: ENFORCEMENT_MODE.ENFORCE }),
    ).toContain('enforcing');
  });

  it('escapes decision text, which is attacker-influenced', () => {
    const page = renderDashboard({
      ...STATUS,
      recent: [
        {
          occurredAt: '2026-08-11T05:16:00Z',
          effect: 'block',
          agentName: 'local-editor',
          action: 'file.write',
          target: '<img src=x onerror=alert(1)>',
          reason: 'secret in diff',
        },
      ],
    });

    expect(page).not.toContain('<img src=x');
    expect(page).toContain('&lt;img src=x');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeHtml('rm -rf ./build')).toBe('rm -rf ./build');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });
});
