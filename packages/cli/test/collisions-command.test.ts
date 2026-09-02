import { describe, expect, it } from 'vitest';
import type { ActionEvent } from '@memnox/core';
import { registerCollisionsCommand } from '../src/commands/collisions.command';
import { FakeRuntime, runCommand } from './cli-harness';

const NOW = '2026-08-31T12:00:00.000Z';

function event(overrides: Partial<ActionEvent>): ActionEvent {
  return {
    id: 'evt_1',
    occurredAt: '2026-08-31T11:50:00.000Z',
    agentId: 'agt_1',
    agentName: 'claude-code',
    action: 'code.modify',
    target: 'src/payments.ts',
    effect: 'allow',
    riskLevel: 'medium',
    matchedPolicies: [],
    advisories: [],
    reason: 'no rule matched',
    ...overrides,
  } as ActionEvent;
}

async function run(events: ActionEvent[], args: string[] = []) {
  const runtime = new FakeRuntime().handle('GET', '/v1/audit', () => ({ body: events }));
  return runCommand(
    (program, context) => registerCollisionsCommand(program, context, () => NOW),
    ['collisions', ...args],
    runtime,
  );
}

describe('memnox collisions', () => {
  it('names two agents inside one production-critical file', async () => {
    const { out } = await run([
      event({}),
      event({
        id: 'evt_2',
        agentId: 'agt_2',
        agentName: 'codex',
        occurredAt: '2026-08-31T11:56:00.000Z',
      }),
    ]);

    expect(out.text).toContain('CONCURRENT WORK');
    expect(out.text).toContain('src/payments.ts');
    expect(out.text).toContain('claude-code');
    expect(out.text).toContain('codex');
  });

  /** A read is not a collision, and reporting one trains people to skip the report. */
  it('leaves two readers alone', async () => {
    const { out } = await run([
      event({ action: 'repository.read' }),
      event({
        id: 'evt_2',
        agentId: 'agt_2',
        agentName: 'codex',
        action: 'repository.read',
      }),
    ]);

    expect(out.text).toContain('No two agents');
  });

  it('names duplicated effort across two branches', async () => {
    const { out } = await run([
      event({
        target: 'src/auth/tokens.ts',
        occurredAt: '2026-08-28T09:00:00.000Z',
        branch: 'oauth-refresh',
      }),
      event({
        id: 'e2',
        target: 'src/auth/session.ts',
        occurredAt: '2026-08-28T09:05:00.000Z',
        branch: 'oauth-refresh',
      }),
      event({
        id: 'e3',
        agentId: 'agt_2',
        agentName: 'codex',
        target: 'src/auth/tokens.ts',
        occurredAt: '2026-08-30T09:00:00.000Z',
        branch: 'token-rotation',
      }),
      event({
        id: 'e4',
        agentId: 'agt_2',
        agentName: 'codex',
        target: 'src/auth/session.ts',
        occurredAt: '2026-08-30T09:05:00.000Z',
        branch: 'token-rotation',
      }),
    ]);

    expect(out.text).toContain('DUPLICATE EFFORT');
    expect(out.text).toContain('oauth-refresh');
    expect(out.text).toContain('token-rotation');
    expect(out.text).toContain('src/auth/tokens.ts');
  });

  it('refuses a window that is not a positive number', async () => {
    await expect(run([], ['--window', '0'])).rejects.toThrow(/--window must be/);
  });
});
