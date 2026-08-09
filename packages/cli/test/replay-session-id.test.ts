import { afterEach, describe, expect, it } from 'vitest';
import { FakeRuntime, runCli } from './cli-harness';

const AUDIT_PATH = '/v1/audit';

const event = (sessionId: string): Record<string, unknown> => ({
  id: 'evt_1',
  occurredAt: '2026-08-07T00:00:00.000Z',
  effect: 'allow',
  action: 'file.write',
  target: 'src/a.ts',
  reason: 'no policy matched',
  advisories: [],
  sessionId,
});

afterEach(() => {
  process.exitCode = undefined;
});

describe('memnox replay', () => {
  it('refuses an empty session id instead of replaying the whole trail', async () => {
    const runtime = new FakeRuntime().on('GET', AUDIT_PATH, [event(''), event('')]);

    const { out } = await runCli(['replay', ''], runtime);

    // Every unstamped event matches an empty id, which reads as one session
    // having done all of it.
    expect(out.text).toContain('A session id is required');
    expect(runtime.requests).toHaveLength(0);
    expect(process.exitCode).toBe(1);
  });

  it('refuses whitespace the same way', async () => {
    const runtime = new FakeRuntime().on('GET', AUDIT_PATH, [event('')]);

    await runCli(['replay', '   '], runtime);

    expect(runtime.requests).toHaveLength(0);
  });

  it('still replays a real session', async () => {
    const runtime = new FakeRuntime().on('GET', AUDIT_PATH, [event('sess-1')]);

    const { out } = await runCli(['replay', 'sess-1'], runtime);

    expect(out.text).toContain('Session sess-1 — 1 action(s)');
    expect(process.exitCode).toBeUndefined();
  });
});
