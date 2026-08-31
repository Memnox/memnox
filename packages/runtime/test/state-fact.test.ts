import { beforeEach, describe, expect, it } from 'vitest';
import { AGENT_KIND, DECISION_EFFECT } from '@memnox/core';
import { STATE_FACT_KIND, validateStateFact, type StateFact } from '@memnox/org-graph';
import { PolicyEngine, type Policy } from '@memnox/policy-engine';
import { ActionGateway } from '../src/action-gateway';
import { InMemoryApprovalStore } from '../src/stores/in-memory-approval-store';
import { InMemoryAuditLog } from '../src/stores/in-memory-audit-log';
import { InMemoryIdentityStore } from '../src/stores/in-memory-identity-store';
import { InMemoryStateStore } from '../src/stores/json-file-state-store';

/** A merge refused because an incident is open: the thesis in one verdict. */
const POLICIES: Policy[] = [
  {
    name: 'no-merge-during-a-freeze',
    match: { actions: ['repository.merge'], state: [STATE_FACT_KIND.FREEZE] },
    decision: {
      effect: DECISION_EFFECT.WITHHOLD,
      reason: 'a deployment freeze is in force',
    },
  },
];

const freeze = (over: Partial<StateFact> = {}): StateFact => ({
  id: 'st_1',
  workspaceId: 'ws_1',
  kind: STATE_FACT_KIND.FREEZE,
  scope: { environments: ['production'] },
  value: 'release freeze',
  ref: 'INC-928',
  validFrom: '2026-08-30T00:00:00.000Z',
  validUntil: '2099-01-01T00:00:00.000Z',
  version: 3,
  ...over,
});

describe('organizational state as a policy input', () => {
  let gateway: ActionGateway;
  let state: InMemoryStateStore;
  let token: string;

  const merge = { action: 'repository.merge', environment: 'production' };

  beforeEach(async () => {
    state = new InMemoryStateStore();
    gateway = new ActionGateway({
      identityStore: new InMemoryIdentityStore(),
      auditLog: new InMemoryAuditLog(),
      approvalStore: new InMemoryApprovalStore(),
      policyEngine: new PolicyEngine(POLICIES),
      state,
    });
    token = (await gateway.registerAgent('claude-code', AGENT_KIND.CLAUDE_CODE)).token;
  });

  it('refuses the merge while the freeze is in force', async () => {
    await state.save(freeze());

    const decision = await gateway.authorize(token, merge);

    expect(decision.effect).toBe(DECISION_EFFECT.WITHHOLD);
    expect(decision.reason).toContain('deployment freeze');
  });

  it('allows it once the freeze has lapsed, rather than refusing forever', async () => {
    await state.save(freeze({ validUntil: '2026-08-30T12:00:00.000Z' }));

    const decision = await gateway.authorize(token, merge);

    expect(decision.effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('leaves an environment the freeze does not name alone', async () => {
    await state.save(freeze());

    const decision = await gateway.authorize(token, {
      action: 'repository.merge',
      environment: 'staging',
    });

    expect(decision.effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('allows it when nobody has declared any state at all', async () => {
    const decision = await gateway.authorize(token, merge);

    expect(decision.effect).toBe(DECISION_EFFECT.ALLOW);
  });
});

describe('a state fact with no end', () => {
  it('is refused, because a freeze that outlives its incident is worse than none', () => {
    const forever = { ...freeze(), validUntil: '' } as StateFact;

    expect(validateStateFact(forever).ok).toBe(false);
  });

  it('is refused when it ends before it starts', () => {
    const backwards = freeze({ validUntil: '2026-08-29T00:00:00.000Z' });

    expect(validateStateFact(backwards).ok).toBe(false);
  });
});
