import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DECISION_EFFECT,
  ENFORCEMENT_MODE,
  EXECUTION_STATUS,
  RISK_LEVEL,
} from '@memnox/core';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { registerTraceCommand } from '../src/commands/trace.command';
import { plainStyle } from '../src/style';
import { FakeRuntime } from './cli-harness';

const AUDIT_PATH = '/v1/audit';

const decision = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'evt_1',
  occurredAt: '2026-08-25T09:12:03.000Z',
  agentId: 'agt_1',
  agentName: 'local-editor',
  principal: 'moise',
  sessionId: 'sess-1',
  action: 'database.delete',
  target: 'production.users',
  environment: 'production',
  effect: DECISION_EFFECT.WITHHOLD,
  riskLevel: RISK_LEVEL.CRITICAL,
  matchedPolicies: ['production-database-protection'],
  policyVersion: '8f21cdea41b2',
  advisories: ['decision-memory'],
  approvers: ['platform-lead'],
  reason: 'No AI-initiated destructive database operations in production.',
  prevHash: '71cd0f2a9b3c4d5e',
  hash: '9f2ab41c77de0012',
  ...over,
});

async function run(args: string[], runtime: FakeRuntime): Promise<RecordedOutput> {
  const out = new RecordedOutput();
  const program = new Command();
  registerTraceCommand(
    program,
    new CliContext(out, runtime.transport, plainStyle, async () => ({}), {}),
  );
  await program.parseAsync(args, { from: 'user' });
  return out;
}

beforeEach(() => {
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

describe('memnox trace', () => {
  it('walks the chain from the request to the verdict', async () => {
    const runtime = new FakeRuntime().on('GET', AUDIT_PATH, [decision()]);

    const out = await run(['trace', 'evt_1'], runtime);

    expect(out.text).toContain('MEMNOX TRACE  evt_1');
    expect(out.text).toContain('database.delete production.users [production]');
    expect(out.text).toContain('by local-editor (agt_1) on behalf of moise');
    expect(out.text).toContain('Rules       production-database-protection');
    expect(out.text).toContain('Signals     decision-memory');
    expect(out.text).toContain('BLOCK');
    expect(out.text).toContain('Asked       platform-lead');
  });

  it('ticks only the evidence the record actually carries', async () => {
    const runtime = new FakeRuntime().on('GET', AUDIT_PATH, [
      decision({ principal: undefined, policyVersion: undefined }),
    ]);

    const out = await run(['trace', 'evt_1'], runtime);

    expect(out.text).toContain('✓ agent identity');
    expect(out.text).toContain('· human principal   not stated by the caller');
    expect(out.text).toContain('· rule set version  not stamped');
    expect(out.text).toContain(
      '✓ tamper evidence   chained — 71cd0f2a9b3c… → 9f2ab41c77de…',
    );
  });

  it('says an unchained event is unchained rather than implying proof', async () => {
    const runtime = new FakeRuntime().on('GET', AUDIT_PATH, [
      decision({ hash: undefined, prevHash: undefined }),
    ]);

    const out = await run(['trace', 'evt_1'], runtime);

    expect(out.text).toContain('· tamper evidence   this event is not chained');
  });

  it('names the mode that softened a verdict', async () => {
    const runtime = new FakeRuntime().on('GET', AUDIT_PATH, [
      decision({
        effect: DECISION_EFFECT.ALLOW,
        shadowEffect: DECISION_EFFECT.WITHHOLD,
        enforcementMode: ENFORCEMENT_MODE.OBSERVE,
      }),
    ]);

    const out = await run(['trace', 'evt_1'], runtime);

    expect(out.text).toContain(
      'shadow: enforce would have said withhold, but production is in observe mode',
    );
  });

  it('joins a decision to the outcome that reported on it', async () => {
    const runtime = new FakeRuntime().on('GET', AUDIT_PATH, [
      decision({ effect: DECISION_EFFECT.ALLOW }),
      {
        ...decision({ id: 'evt_2' }),
        decisionEventId: 'evt_1',
        action: 'execution.outcome',
        executionStatus: EXECUTION_STATUS.SUCCEEDED,
      },
    ]);

    const out = await run(['trace', 'evt_1'], runtime);

    expect(out.text).toContain(`Outcome     ${EXECUTION_STATUS.SUCCEEDED}`);
    expect(out.text).toContain('✓ reported outcome  evt_2');
  });

  it('calls out an agent that claimed to act without permission', async () => {
    const runtime = new FakeRuntime().on('GET', AUDIT_PATH, [
      decision(),
      {
        ...decision({ id: 'evt_2' }),
        decisionEventId: 'evt_1',
        action: 'execution.outcome',
        defiedVerdict: true,
      },
    ]);

    const out = await run(['trace', 'evt_1'], runtime);

    expect(out.text).toContain(
      'the agent reported acting on a decision that did not allow it',
    );
  });

  it('names the missing testimony when an allowed action reported nothing', async () => {
    const runtime = new FakeRuntime().on('GET', AUDIT_PATH, [
      decision({ effect: DECISION_EFFECT.ALLOW }),
    ]);

    const out = await run(['trace', 'evt_1'], runtime);

    expect(out.text).toContain('the caller reported no outcome');
    expect(out.text).toContain('· reported outcome  never reported');
  });

  it('traces the most recent decision when given no id', async () => {
    // The audit route answers newest first; the oldest event must not win.
    const runtime = new FakeRuntime().on('GET', AUDIT_PATH, [
      decision({ id: 'evt_9', action: 'file.write' }),
      decision(),
    ]);

    const out = await run(['trace'], runtime);

    expect(out.text).toContain('MEMNOX TRACE  evt_9');
  });

  it('never traces an outcome event as if it were a decision', async () => {
    const runtime = new FakeRuntime().on('GET', AUDIT_PATH, [
      { ...decision({ id: 'evt_2' }), decisionEventId: 'evt_1' },
      decision(),
    ]);

    const out = await run(['trace'], runtime);

    expect(out.text).toContain('MEMNOX TRACE  evt_1');
  });

  it('says how to widen the search when the id is not in the window', async () => {
    const runtime = new FakeRuntime().on('GET', AUDIT_PATH, [decision()]);

    const out = await run(['trace', 'evt_missing'], runtime);

    expect(out.text).toContain('--window');
    expect(process.exitCode).toBe(1);
  });

  it('emits the decision and its outcome as JSON when asked', async () => {
    const runtime = new FakeRuntime().on('GET', AUDIT_PATH, [decision()]);

    const out = await run(['trace', 'evt_1', '--json'], runtime);

    const parsed = JSON.parse(out.text) as { decision: { id: string }; outcome: unknown };
    expect(parsed.decision.id).toBe('evt_1');
    expect(parsed.outcome).toBeNull();
  });

  it('refuses a window that is not a positive count', async () => {
    const runtime = new FakeRuntime().on('GET', AUDIT_PATH, [decision()]);

    await expect(run(['trace', '--window', '0'], runtime)).rejects.toThrow(
      /--window must be a positive number/,
    );
  });
});
