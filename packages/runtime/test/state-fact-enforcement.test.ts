import { beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_KIND,
  DECISION_EFFECT,
  STATE_FACT_KIND,
  STATE_VERSION_NONE,
  type StateFact,
  type StateFactStore,
} from '@memnox/core';
import { PolicyEngine, type Policy } from '@memnox/policy-engine';
import { ActionGateway } from '../src/action-gateway';
import { InMemoryApprovalStore } from '../src/stores/in-memory-approval-store';
import { InMemoryAuditLog } from '../src/stores/in-memory-audit-log';
import { InMemoryIdentityStore } from '../src/stores/in-memory-identity-store';

/** The rule an incident writes: ordinary until a freeze covers production. */
const POLICIES: Policy[] = [
  {
    name: 'no-deploys-during-a-freeze',
    match: {
      actions: ['deploy.*'],
      environments: ['production'],
      state: ['freeze:production'],
    },
    decision: {
      effect: DECISION_EFFECT.WITHHOLD,
      reason: 'a deployment freeze is in force',
    },
  },
];

class FakeStateFacts implements StateFactStore {
  constructor(private facts: StateFact[] = []) {}
  async save(fact: StateFact): Promise<void> {
    this.facts.push(fact);
  }
  async list(): Promise<StateFact[]> {
    return [...this.facts];
  }
  async remove(id: string): Promise<boolean> {
    const before = this.facts.length;
    this.facts = this.facts.filter((fact) => fact.id !== id);
    return this.facts.length !== before;
  }
}

/** Unreadable is not empty: the gateway must still decide, and must say it could not read. */
class BrokenStateFacts implements StateFactStore {
  async save(): Promise<void> {
    throw new Error('unreadable');
  }
  async list(): Promise<StateFact[]> {
    throw new Error('state facts unreadable');
  }
  async remove(): Promise<boolean> {
    throw new Error('unreadable');
  }
}

function freeze(overrides: Partial<StateFact> = {}): StateFact {
  const hourFromNow = new Date(Date.now() + 3_600_000).toISOString();
  return {
    id: 'freeze-1',
    kind: STATE_FACT_KIND.FREEZE,
    scope: ['production'],
    reason: 'incident 421 is open',
    source: 'platform on-call',
    declaredAt: new Date(Date.now() - 3_600_000).toISOString(),
    validUntil: hourFromNow,
    ...overrides,
  };
}

async function enrol(gateway: ActionGateway): Promise<string> {
  const { token } = await gateway.registerAgent({
    name: 'claude-code',
    kind: AGENT_KIND.CLAUDE_CODE,
    role: 'release-engineer',
    principal: 'moise',
  });
  return token;
}

function buildGateway(stateFacts?: StateFactStore): {
  gateway: ActionGateway;
  auditLog: InMemoryAuditLog;
} {
  const auditLog = new InMemoryAuditLog();
  const gateway = new ActionGateway({
    identityStore: new InMemoryIdentityStore(),
    auditLog,
    approvalStore: new InMemoryApprovalStore(),
    policyEngine: new PolicyEngine(POLICIES),
    ...(stateFacts === undefined ? {} : { stateFacts }),
  });
  return { gateway, auditLog };
}

describe('a state fact in the decision path', () => {
  let request: { action: string; environment: string };

  beforeEach(() => {
    request = { action: 'deploy.service', environment: 'production' };
  });

  it('allows the deploy when no freeze is in force', async () => {
    const { gateway } = buildGateway(new FakeStateFacts());
    const decision = await gateway.authorize(await enrol(gateway), request);
    expect(decision.effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('withholds the same deploy while a freeze covers production', async () => {
    const { gateway } = buildGateway(new FakeStateFacts([freeze()]));
    const decision = await gateway.authorize(await enrol(gateway), request);
    expect(decision.effect).toBe(DECISION_EFFECT.WITHHOLD);
    expect(decision.reason).toContain('freeze');
  });

  it('allows it again once the freeze has lapsed, without anybody lifting it', async () => {
    const lapsed = freeze({ validUntil: new Date(Date.now() - 1_000).toISOString() });
    const { gateway } = buildGateway(new FakeStateFacts([lapsed]));
    const decision = await gateway.authorize(await enrol(gateway), request);
    expect(decision.effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('ignores a freeze scoped to something else', async () => {
    const elsewhere = freeze({ scope: ['staging'] });
    const { gateway } = buildGateway(new FakeStateFacts([elsewhere]));
    const decision = await gateway.authorize(await enrol(gateway), request);
    expect(decision.effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('decides without facts when the store cannot be read, rather than crashing', async () => {
    const { gateway } = buildGateway(new BrokenStateFacts());
    const decision = await gateway.authorize(await enrol(gateway), request);
    expect(decision.effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('leaves a state-bearing rule inert when no store is configured at all', async () => {
    const { gateway } = buildGateway();
    const decision = await gateway.authorize(await enrol(gateway), request);
    expect(decision.effect).toBe(DECISION_EFFECT.ALLOW);
  });
});

describe('the version stamped on a verdict', () => {
  it('records "none" when nothing was in force, so a bundle that never arrived shows', async () => {
    const { gateway, auditLog } = buildGateway(new FakeStateFacts());
    await gateway.authorize(await enrol(gateway), {
      action: 'deploy.service',
      environment: 'production',
    });
    const [event] = await auditLog.recent(1);
    expect(event?.stateVersion).toBe(STATE_VERSION_NONE);
  });

  it('records a real version when a freeze decided it, so the verdict traces to it', async () => {
    const { gateway, auditLog } = buildGateway(new FakeStateFacts([freeze()]));
    await gateway.authorize(await enrol(gateway), {
      action: 'deploy.service',
      environment: 'production',
    });
    const [event] = await auditLog.recent(1);
    expect(event?.stateVersion).not.toBe(STATE_VERSION_NONE);
    expect(event?.effect).toBe(DECISION_EFFECT.WITHHOLD);
  });
});
