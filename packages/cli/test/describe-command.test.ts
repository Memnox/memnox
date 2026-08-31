import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT, RISK_LEVEL } from '@memnox/core';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { registerDescribeCommand } from '../src/commands/describe.command';
import { plainStyle } from '../src/style';
import { FakeRuntime } from './cli-harness';

const RISK_PATH = '/v1/evaluate-risk';
const POLICIES_PATH = '/v1/policies';
const SEARCH_PATH = '/v1/memory/decisions/search';
const AUDIT_PATH = '/v1/audit';

const assessment = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  effect: DECISION_EFFECT.WITHHOLD,
  riskLevel: RISK_LEVEL.CRITICAL,
  reason: 'No AI-initiated destructive database operations in production.',
  matchedPolicies: [
    {
      name: 'production-database-protection',
      effect: DECISION_EFFECT.WITHHOLD,
      reason: 'Production data is not agent-deletable.',
      approvers: ['platform-lead'],
    },
  ],
  advisories: [],
  trustScore: 74,
  ...over,
});

const ruleSet = {
  version: 'v1',
  policyCount: 1,
  policyNames: ['production-database-protection'],
  policies: [
    {
      name: 'production-database-protection',
      match: {
        actions: ['database.delete', 'database.drop', 'database.truncate'],
        environments: ['production'],
      },
    },
  ],
};

const auditEvent = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'evt_1',
  occurredAt: '2026-08-25T09:12:03.000Z',
  agentId: 'agt_1',
  agentName: 'local-editor',
  action: 'database.delete',
  effect: DECISION_EFFECT.WITHHOLD,
  riskLevel: RISK_LEVEL.CRITICAL,
  matchedPolicies: ['production-database-protection'],
  advisories: [],
  reason: 'withheld',
  ...over,
});

/** Everything `describe` reads, so a test opts out by overriding one route. */
const governed = (): FakeRuntime =>
  new FakeRuntime()
    .on('POST', RISK_PATH, assessment())
    .on('GET', POLICIES_PATH, ruleSet)
    .on('GET', SEARCH_PATH, [])
    .on('GET', AUDIT_PATH, [auditEvent()]);

async function run(args: string[], runtime: FakeRuntime): Promise<RecordedOutput> {
  const out = new RecordedOutput();
  const program = new Command();
  registerDescribeCommand(
    program,
    new CliContext(out, runtime.transport, plainStyle, async () => ({}), {}),
    () => '/nowhere',
  );
  await program.parseAsync(args, { from: 'user' });
  return out;
}

describe('memnox describe', () => {
  it('leads with the verdict, the risk, and the agent trust behind it', async () => {
    const out = await run(
      ['describe', 'database.delete', 'production.users', '--token', 'mnx_test'],
      governed(),
    );

    expect(out.text).toContain('WITHHOLD');
    expect(out.text).toContain('risk critical');
    expect(out.text).toContain('agent trust 74/100');
  });

  it('names what else the matched rule governs, minus what was asked about', async () => {
    const out = await run(
      ['describe', 'database.delete', '--env', 'production', '--token', 'mnx_test'],
      governed(),
    );

    expect(out.text).toContain('also governs database.drop, database.truncate');
    // The action and environment asked about are not read back as extra reach.
    expect(out.text).not.toContain('also governs database.delete');
    expect(out.text).not.toContain(
      'also governs database.drop, database.truncate in production',
    );
  });

  it('lists who can authorise it', async () => {
    const out = await run(
      ['describe', 'database.delete', '--token', 'mnx_test'],
      governed(),
    );

    expect(out.text).toContain('Who can authorise it');
    expect(out.text).toContain('platform-lead');
  });

  it('says plainly when no rule covers the action', async () => {
    const runtime = governed().on(
      'POST',
      RISK_PATH,
      assessment({
        effect: DECISION_EFFECT.ALLOW,
        matchedPolicies: [],
        reason: 'no policy matched',
      }),
    );

    const out = await run(['describe', 'http.request', '--token', 'mnx_test'], runtime);

    expect(out.text).toContain('no rule your organization wrote covers this action');
    expect(out.text).toContain('not that it is safe');
  });

  it('quotes the decisions on record that bear on it', async () => {
    const runtime = governed().on('GET', SEARCH_PATH, [
      {
        id: 'DEC-003',
        title: 'Customer data is never deleted in production',
        statement: 'Deletes are soft only.',
        owner: 'platform',
        actions: ['database.delete'],
        decidedAt: '2026-01-04T00:00:00.000Z',
        enforcement: 'withhold',
      },
    ]);

    const out = await run(
      ['describe', 'database.delete', '--token', 'mnx_test'],
      runtime,
    );

    expect(out.text).toContain('DEC-003  Customer data is never deleted in production');
    expect(out.text).toContain('platform — Deletes are soft only.');
  });

  it('counts how the same action went in the recent trail', async () => {
    // The audit route answers newest first, so the head is the latest sighting.
    const runtime = governed().on('GET', AUDIT_PATH, [
      auditEvent({
        id: 'evt_2',
        effect: DECISION_EFFECT.ESCALATE,
        occurredAt: '2026-08-25T11:00:00.000Z',
        agentName: 'ci-runner',
      }),
      auditEvent(),
      auditEvent({ id: 'evt_3', action: 'file.write' }),
    ]);

    const out = await run(
      ['describe', 'database.delete', '--token', 'mnx_test'],
      runtime,
    );

    expect(out.text).toContain(
      '2 of the last 3 audited actions — 1 withheld, 1 held, 0 allowed',
    );
    expect(out.text).toContain('last 2026-08-25T11:00:00.000Z by ci-runner');
  });

  it('says the action would be a first when the trail has never seen it', async () => {
    const runtime = governed().on('GET', AUDIT_PATH, []);

    const out = await run(
      ['describe', 'database.delete', '--token', 'mnx_test'],
      runtime,
    );

    expect(out.text).toContain('this would be the first');
  });

  it('narrows the report rather than failing when an admin surface is closed', async () => {
    const runtime = governed().on('GET', SEARCH_PATH, { error: 'forbidden' }, 403);

    const out = await run(
      ['describe', 'database.delete', '--token', 'mnx_test'],
      runtime,
    );

    expect(out.notes.join('\n')).toContain('Could not read decision memory');
    expect(out.text).toContain('WITHHOLD');
  });

  it('never asks for a decision — every route it uses is read-only', async () => {
    const runtime = governed();

    await run(['describe', 'database.delete', '--token', 'mnx_test'], runtime);

    expect(runtime.requests.map((sent) => sent.path)).not.toContain('/v1/actions/check');
  });

  it('says how to get a token rather than sending an unauthenticated request', async () => {
    const runtime = governed();
    const out = new RecordedOutput();
    const program = new Command();
    registerDescribeCommand(
      program,
      new CliContext(out, runtime.transport, plainStyle, async () => ({}), {}),
    );

    await expect(
      program.parseAsync(['describe', 'database.delete'], { from: 'user' }),
    ).rejects.toThrow(/memnox setup/);
    expect(runtime.requests).toHaveLength(0);
  });
});
