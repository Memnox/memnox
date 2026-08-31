import { beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_KIND,
  DECISION_EFFECT,
  ENFORCEMENT_MODE,
  SEAM_KIND,
  newSeam,
  type Seam,
  type SeamStore,
} from '@memnox/core';
import {
  AUTONOMY_LEVEL,
  READINESS_ITEM,
  READINESS_STATUS,
  blockers,
} from '@memnox/autonomy';
import { PolicyEngine, type Policy } from '@memnox/policy-engine';
import { ActionGateway } from '../src/action-gateway';
import { CONSOLE_LOGGER } from '../src/console-logger';
import { DelegationService, InMemoryDelegationStore } from '../src/delegation-service';
import { LearnService } from '../src/learn-service';
import { ReadinessService } from '../src/readiness-service';
import { InMemoryApprovalStore } from '../src/stores/in-memory-approval-store';
import { InMemoryAuditLog } from '../src/stores/in-memory-audit-log';
import { InMemoryIdentityStore } from '../src/stores/in-memory-identity-store';

class MemorySeams implements SeamStore {
  readonly seams = new Map<string, Seam>();
  async save(seam: Seam): Promise<void> {
    this.seams.set(seam.id, seam);
  }
  async listByAgent(agentId: string): Promise<Seam[]> {
    return [...this.seams.values()].filter((seam) => seam.agentId === agentId);
  }
  async list(): Promise<Seam[]> {
    return [...this.seams.values()];
  }
  async remove(id: string): Promise<boolean> {
    return this.seams.delete(id);
  }
}

const POLICIES: Policy[] = [
  {
    name: 'deploy-needs-a-person',
    match: { actions: ['deploy.*'] },
    decision: { effect: DECISION_EFFECT.ESCALATE, approvers: ['eng-lead'] },
  },
];

describe('readiness is queries, not assertions', () => {
  let readiness: ReadinessService;
  let identities: InMemoryIdentityStore;
  let seams: MemorySeams;
  let agentId: string;
  let audited: boolean;
  let brokered: boolean;

  beforeEach(async () => {
    identities = new InMemoryIdentityStore();
    seams = new MemorySeams();
    audited = false;
    brokered = false;
    const auditLog = new InMemoryAuditLog();
    const gateway = new ActionGateway({
      identityStore: identities,
      auditLog,
      approvalStore: new InMemoryApprovalStore(),
      policyEngine: new PolicyEngine(POLICIES),
    });
    agentId = (await gateway.registerAgent('release-bot', AGENT_KIND.CUSTOM)).agent.id;
    readiness = new ReadinessService({
      identities,
      seams,
      delegations: new DelegationService({
        store: new InMemoryDelegationStore(),
        logger: CONSOLE_LOGGER,
      }),
      learn: new LearnService({
        auditLog,
        rules: () => POLICIES,
        seams: () => seams.list(),
      }),
      rules: () => POLICIES,
      hasAudit: async () => audited,
      hasBrokeredCredentials: async () => brokered,
    });
  });

  const enforceSeam = async () => {
    await seams.save(
      newSeam({
        id: 'seam_1',
        agentId,
        kind: SEAM_KIND.MCP_PROXY,
        mode: ENFORCEMENT_MODE.ENFORCE,
        covers: ['mcp.*'],
        blindTo: [],
      }),
    );
  };

  const nameOwner = async () => {
    const agent = await identities.findById(agentId);
    if (agent === null) throw new Error('no agent');
    await identities.save({ ...agent, owner: 'moise' });
  };

  it('is not met while nobody answers for the agent', async () => {
    const assessed = await readiness.assess(agentId, AUTONOMY_LEVEL.OBSERVE);

    expect(assessed?.ready).toBe(false);
    expect(blockers(assessed!)[0]?.blocker).toBe('nobody answers for this agent');
  });

  it('is met at the lowest level once an owner is named', async () => {
    await nameOwner();

    const assessed = await readiness.assess(agentId, AUTONOMY_LEVEL.OBSERVE);

    expect(assessed?.ready).toBe(true);
  });

  it('names a seam that is installed but not enforcing, not just an absent one', async () => {
    await nameOwner();
    audited = true;
    await seams.save(
      newSeam({
        id: 'seam_1',
        agentId,
        kind: SEAM_KIND.MCP_PROXY,
        mode: ENFORCEMENT_MODE.OBSERVE,
        covers: ['mcp.*'],
        blindTo: [],
      }),
    );

    const assessed = await readiness.assess(agentId, AUTONOMY_LEVEL.ACT_REVERSIBLY);

    expect(assessed?.ready).toBe(false);
    const seam = blockers(assessed!).find(
      (item) => item.key === READINESS_ITEM.SEAM_COVERAGE,
    );
    expect(seam?.blocker).toBe('a seam is installed but not enforcing');
    expect(seam?.remediation).toBe('memnox harden --apply');
  });

  it('reports the highest level the stores actually support', async () => {
    await nameOwner();
    audited = true;
    await enforceSeam();

    // Brokered credentials are still missing, so it stops one rung below autonomous.
    expect(await readiness.highestReady(agentId)).toBe(AUTONOMY_LEVEL.ACT_WITHIN_BOUNDS);
  });

  it('climbs one more rung once leases replace keys', async () => {
    await nameOwner();
    audited = true;
    brokered = true;
    await enforceSeam();

    expect(await readiness.highestReady(agentId)).toBe(AUTONOMY_LEVEL.ACT_AUTONOMOUSLY);
  });

  it('answers nothing about an agent that does not exist, rather than passing it', async () => {
    expect(await readiness.assess('nope', AUTONOMY_LEVEL.OBSERVE)).toBeNull();
  });

  it('marks an item nothing answers as unknown, which is not a pass', async () => {
    await nameOwner();
    audited = true;
    brokered = true;
    await enforceSeam();

    const assessed = await readiness.assess(
      agentId,
      AUTONOMY_LEVEL.HOLD_DELEGATED_AUTHORITY,
    );

    expect(assessed?.ready).toBe(false);
    expect(
      blockers(assessed!).some((item) => item.status === READINESS_STATUS.UNKNOWN),
    ).toBe(true);
  });
});
