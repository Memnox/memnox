import { describe, expect, it } from 'vitest';
import {
  AUTONOMY_LEVEL,
  DETECTOR_KIND,
  READINESS_ITEM,
  READINESS_STATUS,
} from '../src/autonomy.constants';
import {
  assessReadiness,
  blockers,
  demote,
  levelName,
  promote,
  PROMOTION_REFUSAL,
  type AutonomyLevel,
  type ReadinessItem,
} from '../src/level';
import {
  computeRoleEconomics,
  mayActAlone,
  synthesizeRule,
  type ApprovalRecord,
} from '../src/economics';

const LEVEL: AutonomyLevel = {
  key: AUTONOMY_LEVEL.ACT_WITHIN_BOUNDS,
  name: levelName(AUTONOMY_LEVEL.ACT_WITHIN_BOUNDS),
  policyPackId: 'pack_within_bounds',
  requires: [READINESS_ITEM.OWNER, READINESS_ITEM.SEAM_COVERAGE, READINESS_ITEM.ROLLBACK],
};

const met = (key: ReadinessItem['key']): ReadinessItem => ({
  key,
  query: `select … where key = '${key}'`,
  status: READINESS_STATUS.MET,
});

const AT = '2026-08-31T09:00:00.000Z';

describe('readiness', () => {
  it('is not met while an item nothing answers is still unknown', () => {
    const readiness = assessReadiness('agt_1', LEVEL, [
      met(READINESS_ITEM.OWNER),
      met(READINESS_ITEM.SEAM_COVERAGE),
    ]);

    expect(readiness.ready).toBe(false);
    expect(blockers(readiness).map((item) => item.key)).toEqual([
      READINESS_ITEM.ROLLBACK,
    ]);
  });

  it('names the blocker on every item that is not met', () => {
    const readiness = assessReadiness('agt_1', LEVEL, [
      met(READINESS_ITEM.OWNER),
      {
        key: READINESS_ITEM.SEAM_COVERAGE,
        query: 'q',
        status: READINESS_STATUS.UNMET,
        blocker: 'one laptop has the proxy off',
        remediation: 'memnox harden --apply',
      },
      met(READINESS_ITEM.ROLLBACK),
    ]);

    expect(readiness.ready).toBe(false);
    expect(blockers(readiness)[0]?.remediation).toBe('memnox harden --apply');
  });

  it('is met only when every required item resolves against a store', () => {
    const readiness = assessReadiness('agt_1', LEVEL, LEVEL.requires.map(met));

    expect(readiness.ready).toBe(true);
  });
});

describe('moving a level', () => {
  const ready = assessReadiness('agt_1', LEVEL, LEVEL.requires.map(met));

  it('refuses to promote without a person, whatever readiness says', () => {
    const outcome = promote(
      'agt_1',
      AUTONOMY_LEVEL.SUGGEST,
      LEVEL.key,
      ready,
      undefined,
      AT,
    );

    expect(outcome).toEqual({ promoted: false, reason: PROMOTION_REFUSAL.NO_PERSON });
  });

  it('refuses to promote an unready agent even with a person asking', () => {
    const unready = assessReadiness('agt_1', LEVEL, [met(READINESS_ITEM.OWNER)]);

    const outcome = promote(
      'agt_1',
      AUTONOMY_LEVEL.SUGGEST,
      LEVEL.key,
      unready,
      'moise',
      AT,
    );

    expect(outcome).toEqual({ promoted: false, reason: PROMOTION_REFUSAL.NOT_READY });
  });

  it('records who granted a promotion, because that is the accountable human', () => {
    const outcome = promote(
      'agt_1',
      AUTONOMY_LEVEL.SUGGEST,
      LEVEL.key,
      ready,
      'moise',
      AT,
      'prop_1',
    );

    expect(outcome.promoted).toBe(true);
    if (!outcome.promoted) return;
    expect(outcome.change.decidedBy).toBe('moise');
    expect(outcome.change.direction).toBe('promote');
  });

  it('demotes on an incident without waiting for anybody', () => {
    const change = demote('agt_1', LEVEL.key, AUTONOMY_LEVEL.OBSERVE, 'inc_928', AT);

    expect(change.direction).toBe('demote');
    expect(change.cause).toBe('incident');
    expect(change.decidedBy).toBeUndefined();
  });
});

describe('rule synthesis', () => {
  const approval = (id: string, granted = true, decidedBy = 'moise'): ApprovalRecord => ({
    id,
    action: 'deploy.staging',
    decidedBy,
    granted,
  });

  it('drafts a rule once the same question was answered the same way enough times', () => {
    const synthesis = synthesizeRule(
      'ws_1',
      'deploy.staging',
      ['a', 'b', 'c', 'd', 'e'].map((id) => approval(id)),
    );

    expect(synthesis?.support).toBe(5);
    expect(synthesis?.proposalDraft.effect).toBe('allow');
  });

  it('resets on one dissent, rather than putting words in somebody mouth', () => {
    const approvals = ['a', 'b', 'c', 'd'].map((id) => approval(id));
    approvals.push(approval('e', false));

    expect(synthesizeRule('ws_1', 'deploy.staging', approvals)).toBeNull();
  });

  it('says nothing on too little support', () => {
    expect(synthesizeRule('ws_1', 'deploy.staging', [approval('a')])).toBeNull();
  });
});

describe('what widening is worth', () => {
  it('reports cost per completed task, not cost per token', () => {
    const economics = computeRoleEconomics({
      roleId: 'release-engineer',
      window: '7d',
      actions: 400,
      tasksCompleted: 8,
      tasksAbandoned: 2,
      interventions: 3,
      retriedActions: 11,
      refusedActions: 4,
      cents: 1600,
      wastedCents: 240,
    });

    expect(economics.centsPerCompletedTask).toBe(200);
    expect(economics.interventionRate).toBeCloseTo(0.3);
    // Value stays the customer's assumption: we supply counts, never a rate.
    expect(economics.humanRatePerHour).toBeUndefined();
  });
});

describe('detector discipline', () => {
  it('will not let an unmeasured detector act alone', () => {
    expect(
      mayActAlone({
        id: 'd1',
        kind: DETECTOR_KIND.BEHAVIOUR_SHIFT,
        schedule: 'hourly',
        params: {},
      }),
    ).toBe(false);
  });

  it('lets one act alone only once the ledger says it is right often enough', () => {
    expect(
      mayActAlone({
        id: 'd1',
        kind: DETECTOR_KIND.BEHAVIOUR_SHIFT,
        schedule: 'hourly',
        params: {},
        precisionToDate: 0.94,
      }),
    ).toBe(true);
  });
});
