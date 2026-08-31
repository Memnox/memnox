import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { DECISION_EFFECT, RISK_LEVEL } from '@memnox/core';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import {
  EXIT_PLAN_APPROVAL,
  EXIT_PLAN_WITHHELD,
  registerPlanCommand,
} from '../src/commands/plan.command';
import { plainStyle } from '../src/style';
import { FakeRuntime } from './cli-harness';

const RISK_PATH = '/v1/evaluate-risk';
const AUDIT_PATH = '/v1/audit';
const DIR = mkdtempSync(join(tmpdir(), 'memnox-plan-cmd-'));

const PLAN_FILE = join(DIR, 'run.yaml');
writeFileSync(
  PLAN_FILE,
  [
    'version: 1',
    'actions:',
    '  - action: file.write',
    '    target: src/index.ts',
    '  - action: database.migrate',
    '    target: production',
    '    environment: production',
    '  - action: shell.execute',
    '    target: rm -rf /',
  ].join('\n'),
);

interface Verdict {
  effect: string;
  policy?: string;
}

const VERDICTS: Record<string, Verdict> = {
  'file.write': { effect: DECISION_EFFECT.ALLOW },
  'database.migrate': {
    effect: DECISION_EFFECT.ESCALATE,
    policy: 'production-migration-approval',
  },
  'shell.execute': {
    effect: DECISION_EFFECT.WITHHOLD,
    policy: 'recursive-delete-protection',
  },
};

const deciding = (): FakeRuntime =>
  new FakeRuntime().handle('POST', RISK_PATH, (body) => {
    const { action } = body as { action: string };
    const verdict = VERDICTS[action] ?? { effect: DECISION_EFFECT.ALLOW };
    return {
      body: {
        effect: verdict.effect,
        riskLevel: RISK_LEVEL.HIGH,
        reason: `ruled by ${verdict.policy ?? 'nothing'}`,
        matchedPolicies:
          verdict.policy === undefined
            ? []
            : [{ name: verdict.policy, effect: verdict.effect }],
        advisories: [],
        trustScore: 80,
      },
    };
  });

async function run(args: string[], runtime: FakeRuntime): Promise<RecordedOutput> {
  const out = new RecordedOutput();
  const program = new Command();
  registerPlanCommand(
    program,
    new CliContext(out, runtime.transport, plainStyle, async () => ({}), {}),
    () => '/nowhere',
  );
  await program.parseAsync(args, { from: 'user' });
  return out;
}

afterEach(() => {
  process.exitCode = 0;
});

describe('memnox plan', () => {
  it('rules on every action in the plan and totals them', async () => {
    const out = await run(['plan', PLAN_FILE, '--token', 'mnx_test'], deciding());

    expect(out.text).toContain('Memnox plan — 3 action(s)');
    expect(out.text).toContain('Plan: 1 to allow, 1 needing approval, 1 withheld.');
  });

  it('says nothing happened, because nothing did', async () => {
    const runtime = deciding();

    const out = await run(['plan', PLAN_FILE, '--token', 'mnx_test'], runtime);

    expect(out.text).toContain('Nothing was done and nothing was recorded');
    expect(runtime.requests.every((sent) => sent.path === RISK_PATH)).toBe(true);
  });

  it('gives a reason for a stopped action and stays quiet about an allowed one', async () => {
    const out = await run(['plan', PLAN_FILE, '--token', 'mnx_test'], deciding());

    expect(out.text).toContain('recursive-delete-protection');
    expect(out.text).not.toContain('ruled by nothing');
  });

  it('exits withheld when anything in the plan is withheld', async () => {
    await run(['plan', PLAN_FILE, '--token', 'mnx_test'], deciding());

    expect(process.exitCode).toBe(EXIT_PLAN_WITHHELD);
  });

  it('exits approval when the worst verdict is a hold', async () => {
    const runtime = new FakeRuntime().handle('POST', RISK_PATH, (body) => {
      const { action } = body as { action: string };
      return {
        body: {
          effect:
            action === 'database.migrate'
              ? DECISION_EFFECT.ESCALATE
              : DECISION_EFFECT.ALLOW,
          riskLevel: RISK_LEVEL.MEDIUM,
          reason: 'held',
          matchedPolicies: [],
          advisories: [],
          trustScore: 80,
        },
      };
    });

    await run(['plan', PLAN_FILE, '--token', 'mnx_test'], runtime);

    expect(process.exitCode).toBe(EXIT_PLAN_APPROVAL);
  });

  it('applies --env only to entries that do not name one', async () => {
    const runtime = deciding();

    await run(['plan', PLAN_FILE, '--env', 'staging', '--token', 'mnx_test'], runtime);

    const sent = runtime.requests.map(
      (request) => request.body as { environment?: string },
    );
    expect(sent[0]?.environment).toBe('staging');
    expect(sent[1]?.environment).toBe('production');
  });

  it('plans an audited session, skipping the outcome events in it', async () => {
    const runtime = deciding().on('GET', AUDIT_PATH, [
      {
        id: 'evt_1',
        occurredAt: '2026-08-25T09:00:00.000Z',
        agentId: 'agt_1',
        agentName: 'local-editor',
        action: 'shell.execute',
        target: 'rm -rf /',
        effect: DECISION_EFFECT.WITHHOLD,
        riskLevel: RISK_LEVEL.CRITICAL,
        matchedPolicies: [],
        advisories: [],
        reason: 'withheld',
      },
      {
        id: 'evt_2',
        decisionEventId: 'evt_1',
        occurredAt: '2026-08-25T09:00:01.000Z',
        agentId: 'agt_1',
        agentName: 'local-editor',
        action: 'execution.outcome',
        effect: DECISION_EFFECT.ALLOW,
        riskLevel: RISK_LEVEL.LOW,
        matchedPolicies: [],
        advisories: [],
        reason: 'reported',
      },
    ]);

    const out = await run(
      ['plan', '--from-session', 'sess-1', '--token', 'mnx_test'],
      runtime,
    );

    expect(out.text).toContain('Memnox plan — 1 action(s)');
    expect(out.text).toContain('shell.execute rm -rf /');
  });

  it('asks what to plan when given neither a file nor a session', async () => {
    await expect(run(['plan', '--token', 'mnx_test'], deciding())).rejects.toThrow(
      /--from-session/,
    );
  });

  it('points at describe for the first action it stopped', async () => {
    const out = await run(['plan', PLAN_FILE, '--token', 'mnx_test'], deciding());

    expect(out.notes.join('\n')).toContain('memnox describe database.migrate production');
  });

  it('emits the planned verdicts as JSON when asked', async () => {
    const out = await run(
      ['plan', PLAN_FILE, '--json', '--token', 'mnx_test'],
      deciding(),
    );

    const parsed = JSON.parse(out.text) as { planned: unknown[] };
    expect(parsed.planned).toHaveLength(3);
  });
});
