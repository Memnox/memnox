import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
import { FakeRuntime, runCli } from './cli-harness';

const AUDIT_PATH = '/v1/audit';

const event = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  occurredAt: '2026-07-27T10:00:00.000Z',
  effect: DECISION_EFFECT.ALLOW,
  agentName: 'claude-code',
  action: 'file.read',
  reason: 'no policy matched',
  advisories: [],
  ...over,
});

describe('memnox replay', () => {
  it('lists the session in order with a count header', async () => {
    const runtime = new FakeRuntime().on('GET', AUDIT_PATH, [
      event(),
      event({
        effect: DECISION_EFFECT.WITHHOLD,
        action: 'database.delete',
        target: 'users',
        environment: 'production',
        reason: 'destructive',
      }),
    ]);

    const { out } = await runCli(['replay', 'sess-1'], runtime);

    expect(out.lines[0]).toContain('Session sess-1 — 2 action(s):');
    expect(out.text).toContain('file.read — no policy matched');
    expect(out.text).toContain('database.delete users [production] — destructive');
  });

  it('appends advisory signals when the decision carried any', async () => {
    const runtime = new FakeRuntime().on('GET', AUDIT_PATH, [
      event({ advisories: ['taint', 'behavior'] }),
    ]);

    const { out } = await runCli(['replay', 'sess-1'], runtime);

    expect(out.text).toContain('signals: taint, behavior');
  });

  it('says so plainly when the session has no audited actions', async () => {
    const runtime = new FakeRuntime().on('GET', AUDIT_PATH, []);

    const { out } = await runCli(['replay', 'sess-unknown'], runtime);

    expect(out.text).toBe('No audited actions for session sess-unknown.');
  });
});
