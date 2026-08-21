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

/** The address `memnox setup` prints used to return a 404. */
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
    // A page that asks for a token carries none of them; the endpoints stay guarded.
    const page = await server.app.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('This runtime is locked');
    expect(page.body).not.toContain('claude-code');
    expect(page.body).not.toContain('Recent decisions');

    expect(
      (await server.app.inject({ method: 'GET', url: '/v1/status' })).statusCode,
    ).toBe(401);
  });

  it('opens straight into the console on a keyless loopback runtime', async () => {
    const open = await buildServer({ dataDir: `${dataDir}-open` });
    try {
      const page = await open.app.inject({ method: 'GET', url: '/' });

      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('Recent decisions');
      // The token prompt ships with the console for a later 401, but starts hidden.
      expect(page.body).toContain('id="gate" class="gate hidden"');
    } finally {
      await open.app.close();
      await rm(`${dataDir}-open`, { recursive: true, force: true });
    }
  });
});

describe('rendering the page', () => {
  // The value is per-response in the route; the renderer only has to place it.
  const NONCE = 'test-nonce';

  it('names the mode so observing is never mistaken for enforcing', () => {
    expect(renderDashboard(STATUS, NONCE)).toContain('observing');
    expect(
      renderDashboard({ ...STATUS, enforcement: ENFORCEMENT_MODE.ENFORCE }, NONCE),
    ).toContain('enforcing');
  });

  it('escapes decision text, which is attacker-influenced', () => {
    const page = renderDashboard(
      {
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
      },
      NONCE,
    );

    expect(page).not.toContain('<img src=x');
    expect(page).toContain('&lt;img src=x');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeHtml('rm -rf ./build')).toBe('rm -rf ./build');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  // The page can only do what the API already allows; these are the forms that
  // reach the write endpoints, and losing one silently would be hard to notice.
  it('offers the panes a person acts from', () => {
    const page = renderDashboard(STATUS, NONCE);

    ['approvals', 'policies', 'decisions', 'agents', 'console'].forEach((pane) => {
      expect(page).toContain(`data-panel="${pane}"`);
    });
    expect(page).toContain('id="policy-form"');
    expect(page).toContain('id="decision-form"');
    expect(page).toContain('id="agent-form"');
    expect(page).toContain('id="console-form"');
  });

  // Without it the console is a dead end: `memnox setup` registers an agent
  // before anyone opens this page, and its token is shown once and never again.
  it('offers a way to get a token for the console', () => {
    expect(renderDashboard(STATUS, NONCE)).toContain('id="console-token-new"');
  });

  // A comment carrying one would end the embedded script early, and the page
  // would ship a syntax error that only shows up in a browser.
  it('embeds a script with no stray backtick', () => {
    const script =
      renderDashboard(STATUS, NONCE).split(`<script nonce="${NONCE}">`)[1] ?? '';
    expect(script.slice(0, script.indexOf('</script>'))).not.toContain('`');
  });
});
