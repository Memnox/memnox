import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
import { FakeRuntime, runCli } from './cli-harness';

const AUDIT_PATH = '/v1/audit';

const event = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  occurredAt: '2026-07-27T10:00:00.000Z',
  effect: DECISION_EFFECT.WITHHOLD,
  agentName: 'claude-code',
  action: 'database.delete',
  target: 'users',
  environment: 'production',
  reason: 'destructive operation',
  ...over,
});

describe('memnox audit', () => {
  it('prints one line per event with the effect column aligned', async () => {
    const runtime = new FakeRuntime().on('GET', AUDIT_PATH, [event()]);

    const { out } = await runCli(['audit'], runtime);

    expect(out.text).toContain('2026-07-27T10:00:00.000Z');
    expect(out.text).toContain('WITHHOLD');
    expect(out.text).toContain('claude-code: database.delete users [production]');
    expect(out.text).toContain('destructive operation');
  });

  it('passes --limit through to the query', async () => {
    const runtime = new FakeRuntime().on('GET', AUDIT_PATH, []);

    await runCli(['audit', '--limit', '5'], runtime);

    expect(runtime.requests[0]?.path).toBe(AUDIT_PATH);
  });

  it('says so plainly when nothing has been audited', async () => {
    const runtime = new FakeRuntime().on('GET', AUDIT_PATH, []);

    const { out } = await runCli(['audit'], runtime);

    expect(out.text).toBe('No audited actions yet.');
  });
});

describe('memnox audit verify', () => {
  it('reports how many events were verified when the chain is intact', async () => {
    const runtime = new FakeRuntime().on('GET', `${AUDIT_PATH}/verify`, {
      valid: true,
      checked: 128,
    });

    const { out } = await runCli(['audit', 'verify'], runtime);

    expect(out.text).toBe('Audit chain intact — 128 events verified.');
  });

  it('throws with the broken link so the process exits non-zero', async () => {
    const runtime = new FakeRuntime().on(`GET`, `${AUDIT_PATH}/verify`, {
      valid: false,
      checked: 40,
      brokenAtIndex: 12,
      brokenEventId: 'evt_12',
      brokenReason: 'hash mismatch',
    });

    await expect(runCli(['audit', 'verify'], runtime)).rejects.toThrow(
      /BROKEN at event #12 \(evt_12\): hash mismatch/,
    );
  });
});

describe('memnox audit — connection flags', () => {
  it('sends the audit query to the --url the caller gave', async () => {
    const runtime = new FakeRuntime().on('GET', AUDIT_PATH, []);

    await runCli(['audit', '--url', 'http://runtime.example:9000'], runtime);

    expect(runtime.requests[0]?.url).toContain('http://runtime.example:9000');
  });

  // Regression: audit and audit-verify both declared --url, so commander bound the
  // flag to the parent and verify silently used its own default host.
  it('sends the verify request to the --url the caller gave', async () => {
    const runtime = new FakeRuntime().on('GET', `${AUDIT_PATH}/verify`, {
      valid: true,
      checked: 1,
    });

    await runCli(['audit', 'verify', '--url', 'http://runtime.example:9000'], runtime);

    expect(runtime.requests[0]?.url).toContain('http://runtime.example:9000');
  });

  it('passes the admin token through on verify', async () => {
    const runtime = new FakeRuntime().on('GET', `${AUDIT_PATH}/verify`, {
      valid: true,
      checked: 1,
    });

    await runCli(['audit', 'verify', '--admin-token', 'admin-secret'], runtime);

    expect(runtime.requests[0]?.authorization).toBe('Bearer admin-secret');
  });
});
