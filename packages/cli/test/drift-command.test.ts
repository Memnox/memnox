import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DECISION_EFFECT, ENFORCEMENT_MODE, RISK_LEVEL } from '@memnox/core';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { EXIT_DRIFT, registerDriftCommand } from '../src/commands/drift.command';
import { plainStyle } from '../src/style';
import { FakeRuntime } from './cli-harness';

const AUDIT_PATH = '/v1/audit';
const ENFORCEMENT_PATH = '/v1/enforcement';
const POLICIES_PATH = '/v1/policies';
const HEALTH_PATH = '/v1/memory/health';

const event = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'evt_1',
  occurredAt: '2026-08-25T09:12:03.000Z',
  agentId: 'agt_1',
  agentName: 'local-editor',
  action: 'database.delete',
  effect: DECISION_EFFECT.ALLOW,
  riskLevel: RISK_LEVEL.CRITICAL,
  matchedPolicies: ['production-database-protection'],
  advisories: [],
  reason: 'observed only',
  ...over,
});

const healthy = {
  score: 100,
  activeDecisions: 0,
  stale: 0,
  frequentlyViolated: 0,
  neverReferenced: 0,
  entries: [],
};

/** A runtime whose rules and history agree; a test breaks one route at a time. */
const aligned = (): FakeRuntime =>
  new FakeRuntime()
    .on('GET', AUDIT_PATH, [event({ effect: DECISION_EFFECT.BLOCK })])
    .on('GET', ENFORCEMENT_PATH, { default: ENFORCEMENT_MODE.ENFORCE })
    .on('GET', POLICIES_PATH, {
      version: 'v1',
      policyCount: 1,
      policyNames: ['production-database-protection'],
      policies: [],
    })
    .on('GET', HEALTH_PATH, healthy);

async function run(args: string[], runtime: FakeRuntime): Promise<RecordedOutput> {
  const out = new RecordedOutput();
  const program = new Command();
  registerDriftCommand(
    program,
    new CliContext(out, runtime.transport, plainStyle, async () => ({}), {}),
  );
  await program.parseAsync(args, { from: 'user' });
  return out;
}

// A clean slate both sides: "no drift" asserts that nothing set a code at all.
beforeEach(() => {
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

describe('memnox drift', () => {
  it('reports no drift when the rules and the trail agree', async () => {
    const out = await run(['drift'], aligned());

    expect(out.text).toContain('No drift — your rules and your history agree.');
    expect(process.exitCode).toBe(0);
  });

  it('names verdicts a monitored environment let through', async () => {
    const runtime = aligned().on('GET', AUDIT_PATH, [
      event({ withheldEffect: DECISION_EFFECT.BLOCK, environment: 'production' }),
      event({
        id: 'evt_2',
        withheldEffect: DECISION_EFFECT.BLOCK,
        environment: 'production',
      }),
    ]);

    const out = await run(['drift'], runtime);

    expect(out.text).toContain('Stated but not enforced');
    expect(out.text).toContain(
      '2 action(s) your rules decided to stop were allowed anyway',
    );
    expect(out.text).toContain('database.delete — 2');
    expect(process.exitCode).toBe(EXIT_DRIFT);
  });

  it('flags a default mode that cannot stop anything', async () => {
    const runtime = aligned().on('GET', ENFORCEMENT_PATH, {
      default: ENFORCEMENT_MODE.MONITOR,
    });

    const out = await run(['drift'], runtime);

    expect(out.text).toContain('Rules that cannot decide');
    expect(out.text).toContain('no rule can stop anything');
  });

  it('names an environment held below enforce', async () => {
    const runtime = aligned().on('GET', ENFORCEMENT_PATH, {
      default: ENFORCEMENT_MODE.ENFORCE,
      environments: { staging: ENFORCEMENT_MODE.OFF },
    });

    const out = await run(['drift'], runtime);

    expect(out.text).toContain('staging — "off"');
  });

  it('surfaces a decision agents keep running into', async () => {
    const runtime = aligned().on('GET', HEALTH_PATH, {
      ...healthy,
      score: 60,
      activeDecisions: 1,
      frequentlyViolated: 1,
      entries: [
        {
          id: 'DEC-003',
          title: 'Customer data is never deleted in production',
          violations: 9,
          stale: false,
          neverReferenced: false,
          dueForReview: false,
        },
      ],
    });

    const out = await run(['drift'], runtime);

    expect(out.text).toContain('Stated and repeatedly contradicted');
    expect(out.text).toContain(
      'DEC-003  Customer data is never deleted in production — 9 hit(s)',
    );
  });

  it('lists rules nothing in the window ever matched', async () => {
    const runtime = aligned().on('GET', POLICIES_PATH, {
      version: 'v1',
      policyCount: 2,
      policyNames: ['production-database-protection', 'supply-chain-lockfile'],
      policies: [],
    });

    const out = await run(['drift'], runtime);

    expect(out.text).toContain('Stated and never exercised');
    expect(out.text).toContain('supply-chain-lockfile');
    expect(out.text).not.toContain('  production-database-protection');
  });

  it('flags an active decision that is past review', async () => {
    const runtime = aligned().on('GET', HEALTH_PATH, {
      ...healthy,
      score: 70,
      activeDecisions: 1,
      stale: 1,
      entries: [
        {
          id: 'DEC-007',
          title: 'PostgreSQL is the source of truth',
          violations: 0,
          stale: true,
          neverReferenced: true,
          dueForReview: true,
        },
      ],
    });

    const out = await run(['drift'], runtime);

    expect(out.text).toContain('Stated a long time ago');
    expect(out.text).toContain(
      'DEC-007  PostgreSQL is the source of truth — review date passed',
    );
  });

  it('emits the findings as JSON when asked', async () => {
    const runtime = aligned().on('GET', ENFORCEMENT_PATH, {
      default: ENFORCEMENT_MODE.MONITOR,
    });

    const out = await run(['drift', '--json'], runtime);

    const parsed = JSON.parse(out.text) as { findings: Array<{ heading: string }> };
    expect(parsed.findings[0]?.heading).toBe('Rules that cannot decide');
    expect(process.exitCode).toBe(EXIT_DRIFT);
  });
});
