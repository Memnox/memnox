import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
import {
  canApprove,
  PROPOSAL_ORIGIN,
  PROPOSAL_REFUSAL,
  PROPOSAL_STATE,
  summarizeSimulation,
  type Proposal,
  type SimulationChange,
} from '../src/proposal';

const change = (becomes: SimulationChange['becomes'], id: string): SimulationChange => ({
  decisionId: id,
  was: DECISION_EFFECT.ALLOW,
  becomes,
  action: 'database.delete',
  subjectId: 'sub_1',
});

const simulation = summarizeSimulation(30, 4_120, [
  change(DECISION_EFFECT.WITHHOLD, 'd1'),
  change(DECISION_EFFECT.ESCALATE, 'd2'),
  change(DECISION_EFFECT.ALLOW, 'd3'),
]);

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  id: 'prop_1',
  diff: {},
  state: PROPOSAL_STATE.OPEN,
  origin: PROPOSAL_ORIGIN.LEAST_PRIVILEGE,
  simulation,
  proposedBy: 'moise',
  reviewers: ['security-lead'],
  ...over,
});

describe('simulation', () => {
  it('reports both directions, including what it would newly permit', () => {
    expect(simulation.newlyWithheld).toBe(1);
    expect(simulation.newlyEscalated).toBe(1);
    expect(simulation.newlyAllowed).toBe(1);
  });

  it('says how much it replayed, so the sample size travels with the answer', () => {
    expect(simulation.windowDays).toBe(30);
    expect(simulation.evaluated).toBe(4_120);
  });
});

describe('approving a proposal', () => {
  it('refuses the author, or the review is a formality', () => {
    expect(canApprove(proposal(), 'moise', true)).toEqual({
      ok: false,
      reason: PROPOSAL_REFUSAL.SELF_APPROVAL,
    });
  });

  it('refuses a draft that fails its own test, before a reviewer sees it', () => {
    expect(canApprove(proposal(), 'security-lead', false)).toEqual({
      ok: false,
      reason: PROPOSAL_REFUSAL.UNTESTED,
    });
  });

  it('refuses one with no simulation, because the approver reads the consequence', () => {
    expect(
      canApprove(proposal({ simulation: undefined }), 'security-lead', true),
    ).toEqual({ ok: false, reason: PROPOSAL_REFUSAL.NOT_SIMULATED });
  });

  it('accepts a tested, simulated rule from somebody other than its author', () => {
    expect(canApprove(proposal(), 'security-lead', true)).toEqual({ ok: true });
  });
});
