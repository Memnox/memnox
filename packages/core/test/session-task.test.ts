import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SessionTasks,
  describeDrift,
  isEmptyScope,
  scopeOf,
  subjectOf,
  taskFor,
} from '../src/session/session-task';
import { SCOPE_MATCH } from '../src/domain/task';
import { matchesAny } from '../src/policy/pattern-matcher';
import { LocalGate } from '../src/gate/local-gate';
import { DECISION_EFFECT } from '../src/constants/decision.constants';
import { POLICY_MODE, type Policy } from '../src/policy/policy';

const NOW = '2026-09-05T10:00:00.000Z';
const matches = (patterns: readonly string[], value: string): boolean =>
  matchesAny([...patterns], value);

const checkout = taskFor(
  'ses_1',
  'fix checkout failures',
  { paths: ['src/checkout/**'] },
  NOW,
  40,
);

describe('drift is compared, never guessed', () => {
  it('reads a request inside the declared paths as in scope', () => {
    const drift = scopeOf(
      checkout,
      { action: 'filesystem.write', target: 'src/checkout/cart.ts' },
      matches,
    );
    expect(drift.match).toBe(SCOPE_MATCH.IN_SCOPE);
  });

  it('names the dimension that fell outside, so the refusal can quote it', () => {
    const drift = scopeOf(
      checkout,
      { action: 'filesystem.write', target: 'src/auth/session.ts' },
      matches,
    );
    expect(drift.match).toBe(SCOPE_MATCH.OUT_OF_SCOPE);
    expect(drift.dimension).toBe('path');
    expect(describeDrift(checkout, drift)).toContain('fix checkout failures');
    expect(describeDrift(checkout, drift)).toContain('src/auth/session.ts');
  });

  it('is undeclared when no task was given, which is not a finding', () => {
    const drift = scopeOf(
      null,
      { action: 'filesystem.write', target: 'src/auth/session.ts' },
      matches,
    );
    expect(drift.match).toBe(SCOPE_MATCH.UNDECLARED);
  });

  it('says nothing about a dimension the task never declared', () => {
    const paths = taskFor('ses_1', 'x', { paths: ['src/**'] }, NOW);
    const drift = scopeOf(
      paths,
      { action: 'deploy.service', environment: 'prod' },
      matches,
    );
    // Paths were declared and this names none, so there is nothing to compare.
    expect(drift.match).toBe(SCOPE_MATCH.UNDECLARED);
  });

  it('reads the five dimensions off what the caller already reported', () => {
    const subject = subjectOf({
      action: 'deploy.service',
      target: 'src/checkout',
      workingDirectory: '/work/shop',
      projectId: 'checkout',
      environment: 'production',
    });
    expect(subject).toEqual({
      path: 'src/checkout',
      repository: '/work/shop',
      service: 'checkout',
      environment: 'production',
      resourceKind: 'deploy',
    });
  });

  it('knows a scope that declared nothing at all', () => {
    expect(isEmptyScope({})).toBe(true);
    expect(isEmptyScope({ paths: [] })).toBe(true);
    expect(isEmptyScope({ paths: ['src'] })).toBe(false);
  });
});

describe('a declared task survives the process that declared it', () => {
  it('round-trips, so the seam reads what run wrote', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-task-'));
    const tasks = new SessionTasks(home);
    await tasks.declare(checkout);

    const read = await tasks.read('ses_1');
    expect(read?.statement).toBe('fix checkout failures');
    expect(read?.expectedActions).toBe(40);
    expect(await tasks.read('ses_missing')).toBeNull();
  });

  it('is gone once cleared', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-task-clear-'));
    const tasks = new SessionTasks(home);
    await tasks.declare(checkout);
    await tasks.clear('ses_1');
    expect(await tasks.read('ses_1')).toBeNull();
  });
});

/* The whole point of the wiring: a `scope` rule parsed and validated before this and
   then never fired, because nothing ever put a comparison in front of the engine. */
describe('a scope rule now fires', () => {
  const rule: Policy = {
    name: 'stay-in-the-task',
    match: { actions: ['filesystem.*'], scope: [SCOPE_MATCH.OUT_OF_SCOPE] },
    decision: {
      effect: DECISION_EFFECT.ASK,
      reason: 'this is outside what was asked for',
      mode: POLICY_MODE.ENFORCE,
    },
  } as Policy;

  it('asks about a write outside the declared task', () => {
    const gate = new LocalGate([rule], { agentName: 'claude-code', task: checkout });
    const verdict = gate.evaluate({
      action: 'filesystem.write',
      target: 'src/auth/session.ts',
    });
    expect(verdict.effect).toBe(DECISION_EFFECT.ASK);
    expect(verdict.scope?.dimension).toBe('path');
  });

  it('leaves a write inside the task alone', () => {
    const gate = new LocalGate([rule], { agentName: 'claude-code', task: checkout });
    expect(
      gate.evaluate({ action: 'filesystem.write', target: 'src/checkout/cart.ts' })
        .effect,
    ).toBe(DECISION_EFFECT.ALLOW);
  });

  it('leaves every session that declared nothing alone', () => {
    const gate = new LocalGate([rule], { agentName: 'claude-code' });
    expect(
      gate.evaluate({ action: 'filesystem.write', target: 'src/auth/session.ts' }).effect,
    ).toBe(DECISION_EFFECT.ALLOW);
  });
});

/* Same story: `roles` matched against a field nothing ever set. */
describe('a role rule now fires', () => {
  const rule: Policy = {
    name: 'only-the-deployer-deploys',
    match: { actions: ['deploy.*'], roles: ['tester', 'coder'] },
    decision: {
      effect: DECISION_EFFECT.DENY,
      reason: 'that is the deployment agent’s job, not yours',
      mode: POLICY_MODE.ENFORCE,
    },
  } as Policy;

  it('denies the agent enrolled under a role the rule names', () => {
    const gate = new LocalGate([rule], { agentName: 'claude-code', agentRole: 'coder' });
    expect(gate.evaluate({ action: 'deploy.service' }).effect).toBe(DECISION_EFFECT.DENY);
  });

  it('leaves an agent in another role alone', () => {
    const gate = new LocalGate([rule], {
      agentName: 'claude-code',
      agentRole: 'deployer',
    });
    expect(gate.evaluate({ action: 'deploy.service' }).effect).toBe(
      DECISION_EFFECT.ALLOW,
    );
  });

  it('does not fire when no role was declared, rather than guessing one', () => {
    const gate = new LocalGate([rule], { agentName: 'claude-code' });
    expect(gate.evaluate({ action: 'deploy.service' }).effect).toBe(
      DECISION_EFFECT.ALLOW,
    );
  });
});
