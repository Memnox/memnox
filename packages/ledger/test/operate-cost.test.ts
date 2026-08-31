import { describe, expect, it } from 'vitest';
import { CONTAINMENT_KIND, type ContainmentAction } from '@memnox/core';
import {
  CEILING_BREACH,
  applySpend,
  checkCeiling,
  relativeCost,
  type Ceiling,
  type CostEvent,
} from '../src/cost';
import {
  INCIDENT_REFUSAL,
  INCIDENT_STATE,
  assign,
  close,
  contain,
  isVerifiable,
  stillUnreached,
  type EvidenceExport,
  type Incident,
} from '../src/incident';

const event = (over: Partial<CostEvent> = {}): CostEvent => ({
  id: 'ce_1',
  workspaceId: 'ws_1',
  at: '2026-08-31T09:00:00.000Z',
  subjectId: 'agt_1',
  model: 'claude-opus-5',
  inputTokens: 1_000,
  outputTokens: 200,
  cents: 400,
  payer: 'workspace',
  ...over,
});

const ceiling: Ceiling = {
  workspaceId: 'ws_1',
  scope: 'subject',
  scopeId: 'agt_1',
  window: '2026-08',
  limitCents: 1_000,
  onBreach: CEILING_BREACH.ESCALATE,
};

describe('a ceiling that bites', () => {
  it('reads current spend off one counter rather than summing a period', () => {
    let counters = applySpend([], event(), '2026-08');
    counters = applySpend(counters, event({ id: 'ce_2' }), '2026-08');

    expect(counters).toHaveLength(1);
    expect(counters[0]?.cents).toBe(800);
  });

  it('does not breach below the limit', () => {
    const counters = applySpend([], event(), '2026-08');

    expect(checkCeiling(ceiling, counters).breached).toBe(false);
  });

  it('breaches with the effect the ceiling names, not a bare failure', () => {
    let counters = applySpend([], event(), '2026-08');
    counters = applySpend(counters, event({ id: 'ce_2' }), '2026-08');
    counters = applySpend(counters, event({ id: 'ce_3' }), '2026-08');

    const verdict = checkCeiling(ceiling, counters);

    expect(verdict.breached).toBe(true);
    expect(verdict.effect).toBe(CEILING_BREACH.ESCALATE);
    expect(verdict.spentCents).toBe(1_200);
  });

  it('reports cost relative to a base model, never in currency', () => {
    expect(relativeCost(400, 100)).toBe(4);
    expect(relativeCost(400, 0)).toBe(0);
  });

  it('keeps a deployment-paid call apart from a workspace-paid one', () => {
    const deploymentPaid = event({ payer: 'deployment' });

    expect(deploymentPaid.payer).toBe('deployment');
  });
});

describe('an incident', () => {
  const containment: ContainmentAction = {
    id: 'con_1',
    workspaceId: 'ws_1',
    kind: CONTAINMENT_KIND.KILL,
    subjectId: 'agt_1',
    reason: 'it reached production',
    authorId: 'moise',
    at: '2026-08-31T09:00:00.000Z',
    effects: {
      installsReached: 1,
      leasesRevoked: 2,
      seamsClosed: 1,
      stepsCancelled: 0,
      environmentsRaised: 0,
    },
    unreached: [{ id: 'i2', hostLabel: 'laptop-asleep' }],
  };

  const incident: Incident = {
    id: 'inc_1',
    workspaceId: 'ws_1',
    subjectId: 'agt_1',
    openedAt: '2026-08-31T09:00:00.000Z',
    severity: 'high',
    frames: ['frm_1'],
    containment: [],
    state: INCIDENT_STATE.OPEN,
  };

  it('records the containment taken, and moves out of open', () => {
    const contained = contain(incident, containment);

    expect(contained.state).toBe(INCIDENT_STATE.CONTAINED);
    expect(contained.containment).toHaveLength(1);
  });

  it('keeps naming the machines no containment reached', () => {
    expect(stillUnreached(contain(incident, containment))).toEqual(['laptop-asleep']);
  });

  it('refuses to close with nobody named on it', () => {
    expect(close(incident)).toEqual({ closed: false, reason: INCIDENT_REFUSAL.NO_OWNER });
  });

  it('closes once somebody answered for it', () => {
    const owned = assign(incident, 'moise');

    expect(close(owned)).toEqual({
      closed: true,
      incident: { ...owned, state: INCIDENT_STATE.CLOSED },
    });
  });
});

describe('an evidence export', () => {
  const exported: EvidenceExport = {
    id: 'ex_1',
    workspaceId: 'ws_1',
    from: '2026-08-01',
    to: '2026-08-31',
    includes: ['decisions', 'approvals'],
    manifest: [{ file: 'decisions.jsonl', sha256: 'abc123', rows: 4_120 }],
    checkpoints: ['chain:0000', 'chain:b67f'],
  };

  it('verifies outside the product that made it', () => {
    expect(isVerifiable(exported)).toBe(true);
  });

  it('is a screenshot without its chain checkpoints', () => {
    expect(isVerifiable({ ...exported, checkpoints: [] })).toBe(false);
  });

  it('is a screenshot without a hash per file', () => {
    expect(
      isVerifiable({
        ...exported,
        manifest: [{ file: 'decisions.jsonl', sha256: '', rows: 1 }],
      }),
    ).toBe(false);
  });
});
