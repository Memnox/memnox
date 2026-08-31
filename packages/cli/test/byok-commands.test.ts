import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
import type { LlmProvider } from '@memnox/intelligence';
import { registerDraftCommand } from '../src/commands/draft.command';
import { registerExplainCommand } from '../src/commands/explain.command';
import { registerIntentCommand } from '../src/commands/intent.command';
import type { LlmProviderFactory } from '../src/llm-provider-option';
import { FakeRuntime, runCommand } from './cli-harness';

/** Canned completions, so no BYOK command reaches a network in tests. */
function stubProvider(completion: string): LlmProviderFactory {
  const provider: LlmProvider = {
    name: 'stub',
    complete: async () => completion,
  };
  return () => provider;
}

const auditEvent = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'evt_1',
  occurredAt: '2026-07-27T10:00:00.000Z',
  effect: DECISION_EFFECT.WITHHOLD,
  agentName: 'claude-code',
  action: 'database.delete',
  target: 'users',
  reason: 'destructive',
  advisories: [],
  ...over,
});

describe('memnox explain', () => {
  const runExplain = (
    args: string[],
    factory: LlmProviderFactory,
    runtime: FakeRuntime,
  ): ReturnType<typeof runCommand> =>
    runCommand(
      (program, context) => registerExplainCommand(program, context, factory),
      ['explain', ...args],
      runtime,
    );

  it('explains the most recent event when no id is given', async () => {
    const runtime = new FakeRuntime().on('GET', '/v1/audit', [auditEvent()]);

    const { out } = await runExplain(
      [],
      stubProvider('It deleted production users.'),
      runtime,
    );

    expect(out.text).toContain(`database.delete → ${DECISION_EFFECT.WITHHOLD}`);
    expect(out.text).toContain('It deleted production users.');
  });

  it('explains a specific event by id', async () => {
    const runtime = new FakeRuntime().on('GET', '/v1/audit', [
      auditEvent(),
      auditEvent({ id: 'evt_2', action: 'deploy.production' }),
    ]);

    const { out } = await runExplain(['evt_2'], stubProvider('Policy said so.'), runtime);

    expect(out.text).toContain('deploy.production');
    expect(out.text).not.toContain('database.delete');
  });

  it('fails clearly when the requested event is not in the window', async () => {
    const runtime = new FakeRuntime().on('GET', '/v1/audit', [auditEvent()]);

    await expect(
      runExplain(['evt_missing'], stubProvider('unused'), runtime),
    ).rejects.toThrow(/no audit event "evt_missing"/);
  });

  it('fails clearly when the audit log is empty', async () => {
    const runtime = new FakeRuntime().on('GET', '/v1/audit', []);

    await expect(runExplain([], stubProvider('unused'), runtime)).rejects.toThrow(
      /audit log is empty/,
    );
  });
});

describe('memnox intent', () => {
  const runIntent = (
    args: string[],
    factory: LlmProviderFactory,
  ): ReturnType<typeof runCommand> =>
    runCommand(
      (program, context) => registerIntentCommand(program, context, factory),
      ['intent', ...args],
    );

  const candidates = JSON.stringify({
    actions: [
      { action: 'database.delete', target: 'staging.users', why: 'clears rows' },
      { action: 'database.migrate' },
    ],
  });

  it('lists each candidate action the goal would involve', async () => {
    const { out } = await runIntent(
      ['clean up the staging database'],
      stubProvider(candidates),
    );

    expect(out.text).toContain('Goal        : clean up the staging database');
    expect(out.text).toContain('Highest risk:');
    expect(out.text).toContain('database.delete staging.users — clears rows');
    expect(out.text).toContain('database.migrate');
  });

  it('keeps the advisory disclaimer off stdout so the list stays pipeable', async () => {
    const { out } = await runIntent(['clean up staging'], stubProvider(candidates));

    expect(out.notes.join('\n')).toContain('Advisory only');
    expect(out.text).not.toContain('Advisory only');
  });

  it('says so when no concrete action can be derived', async () => {
    const { out } = await runIntent(
      ['think about things'],
      stubProvider(JSON.stringify({ actions: [] })),
    );

    expect(out.text).toBe('No concrete actions could be derived from that goal.');
  });
});

describe('memnox draft', () => {
  const runDraft = (
    args: string[],
    factory: LlmProviderFactory,
  ): ReturnType<typeof runCommand> =>
    runCommand(
      (program, context) => registerDraftCommand(program, context, factory),
      ['draft', ...args],
    );

  const drafted = JSON.stringify({
    version: 1,
    policies: [
      {
        name: 'no-prod-deletes',
        match: { actions: ['database.delete'], environments: ['production'] },
        decision: { effect: DECISION_EFFECT.WITHHOLD, reason: 'never' },
      },
    ],
  });

  it('prints the YAML on stdout so it can be redirected to a file', async () => {
    const { out } = await runDraft(['block production deletes'], stubProvider(drafted));

    expect(out.text).toContain('no-prod-deletes');
    expect(out.text).toContain('database.delete');
  });

  it('keeps the review reminder on stderr, out of the redirected YAML', async () => {
    const { out } = await runDraft(['block production deletes'], stubProvider(drafted));

    expect(out.notes.join('\n')).toContain('Drafted 1 policy(ies)');
    expect(out.notes.join('\n')).toContain('memnox validate');
    expect(out.text).not.toContain('memnox validate');
  });
});
