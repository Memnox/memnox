import { beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_KIND,
  AGENT_STATUS,
  CONTAINMENT_KIND,
  DECISION_EFFECT,
  DECISION_REASON,
  ENFORCEMENT_MODE,
  SEAM_KIND,
  newSeam,
  type EnvironmentModes,
  type InstallRef,
  type Seam,
  type SeamStore,
} from '@memnox/core';
import { PolicyEngine } from '@memnox/policy-engine';
import { ActionGateway } from '../src/action-gateway';
import {
  ContainmentService,
  CONTAINMENT_REFUSAL,
  type InstallDirectory,
} from '../src/containment-service';
import { CONSOLE_LOGGER } from '../src/console-logger';
import { InMemoryApprovalStore } from '../src/stores/in-memory-approval-store';
import { InMemoryAuditLog } from '../src/stores/in-memory-audit-log';
import { InMemoryIdentityStore } from '../src/stores/in-memory-identity-store';

class MemorySeamStore implements SeamStore {
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

/** One machine answers, one is asleep — which is the ordinary state of a fleet. */
class PartialFleet implements InstallDirectory {
  async list(): Promise<InstallRef[]> {
    return [
      { id: 'i1', hostLabel: 'laptop-awake' },
      { id: 'i2', hostLabel: 'laptop-asleep' },
    ];
  }
  async deliver(install: InstallRef): Promise<boolean> {
    return install.id === 'i1';
  }
}

const NOW = new Date('2026-08-31T09:00:00.000Z');

describe('containment', () => {
  let containment: ContainmentService;
  let seams: MemorySeamStore;
  let raised: EnvironmentModes[];
  let agentId: string;
  let agentToken: string;
  let gateway: ActionGateway;

  beforeEach(async () => {
    seams = new MemorySeamStore();
    raised = [];
    gateway = new ActionGateway({
      identityStore: new InMemoryIdentityStore(),
      auditLog: new InMemoryAuditLog(),
      approvalStore: new InMemoryApprovalStore(),
      policyEngine: new PolicyEngine([]),
    });
    const registered = await gateway.registerAgent('bot', AGENT_KIND.CUSTOM);
    agentId = registered.agent.id;
    agentToken = registered.token;

    await seams.save(
      newSeam({
        id: 'seam_1',
        agentId,
        kind: SEAM_KIND.MCP_PROXY,
        mode: ENFORCEMENT_MODE.ENFORCE,
        covers: ['mcp.*'],
        blindTo: ["the model's reasoning"],
      }),
    );

    containment = new ContainmentService({
      seams,
      installs: new PartialFleet(),
      subjects: {
        hold: async (id, status) => (await gateway.agents.setStatus(id, status)) !== null,
      },
      logger: CONSOLE_LOGGER,
      raiseEnvironments: async (modes) => {
        raised.push(modes);
        return 1;
      },
      clock: () => NOW,
    });
  });

  it('kills one agent: every seam closed, in one recorded action', async () => {
    const outcome = await containment.contain({
      kind: CONTAINMENT_KIND.KILL,
      subjectId: agentId,
      reason: 'it reached production',
      authorId: 'moise',
    });

    expect(outcome.contained).toBe(true);
    if (!outcome.contained) return;
    expect(outcome.action.effects.seamsClosed).toBe(1);
    expect(seams.seams.get('seam_1')?.mode).toBe(ENFORCEMENT_MODE.OFF);
  });

  it('states which installs it did not reach, rather than reporting success', async () => {
    const outcome = await containment.contain({
      kind: CONTAINMENT_KIND.KILL,
      subjectId: agentId,
      reason: 'it reached production',
      authorId: 'moise',
    });

    expect(outcome.contained).toBe(true);
    if (!outcome.contained) return;
    expect(outcome.action.effects.installsReached).toBe(1);
    expect(outcome.action.unreached.map((install) => install.hostLabel)).toEqual([
      'laptop-asleep',
    ]);
  });

  it('quarantines without closing the seam, so the agent stays debuggable', async () => {
    const outcome = await containment.contain({
      kind: CONTAINMENT_KIND.QUARANTINE,
      subjectId: agentId,
      reason: 'behaving oddly',
      authorId: 'moise',
    });

    expect(outcome.contained).toBe(true);
    expect(seams.seams.get('seam_1')?.mode).toBe(ENFORCEMENT_MODE.ENFORCE);
  });

  it('raises every environment on panic', async () => {
    const outcome = await containment.contain({
      kind: CONTAINMENT_KIND.PANIC,
      reason: 'incident 928',
      authorId: 'moise',
      restorePath: 'memnox policy rollback',
    });

    expect(outcome.contained).toBe(true);
    expect(raised).toEqual([{ default: ENFORCEMENT_MODE.ENFORCE }]);
  });

  it('refuses panic with no way back', async () => {
    const outcome = await containment.contain({
      kind: CONTAINMENT_KIND.PANIC,
      reason: 'incident 928',
      authorId: 'moise',
    });

    expect(outcome).toEqual({ contained: false, reason: CONTAINMENT_REFUSAL.NO_RESTORE });
  });

  it('refuses any containment with no reason on the record', async () => {
    const outcome = await containment.contain({
      kind: CONTAINMENT_KIND.KILL,
      subjectId: agentId,
      reason: '   ',
      authorId: 'moise',
    });

    expect(outcome).toEqual({ contained: false, reason: CONTAINMENT_REFUSAL.NO_REASON });
  });

  /* Revoking leases and closing seams leaves every path that asks the runtime directly
     wide open, so a containment that stops there is one the next request walks past. */
  it('suspends the credential on a kill, so the next request is withheld', async () => {
    const outcome = await containment.contain({
      kind: CONTAINMENT_KIND.KILL,
      subjectId: agentId,
      reason: 'it reached production',
      authorId: 'moise',
    });

    expect(outcome.contained).toBe(true);
    if (!outcome.contained) return;
    expect(outcome.action.effects.credentialsHeld).toBe(1);

    const decision = await gateway.authorize(agentToken, { action: 'refund.create' });
    expect(decision.effect).toBe(DECISION_EFFECT.WITHHOLD);
    expect(decision.reason).toBe(DECISION_REASON.AGENT_SUSPENDED);
  });

  it('holds a quarantined agent read-only: reads pass, writes do not', async () => {
    const outcome = await containment.contain({
      kind: CONTAINMENT_KIND.QUARANTINE,
      subjectId: agentId,
      reason: 'behaving oddly',
      authorId: 'moise',
    });

    expect(outcome.contained).toBe(true);
    if (!outcome.contained) return;
    expect(outcome.action.effects.credentialsHeld).toBe(1);

    const read = await gateway.authorize(agentToken, { action: 'filesystem.read' });
    expect(read.effect).toBe(DECISION_EFFECT.ALLOW);

    const write = await gateway.authorize(agentToken, { action: 'refund.create' });
    expect(write.effect).toBe(DECISION_EFFECT.WITHHOLD);
    expect(write.reason).toBe(DECISION_REASON.AGENT_QUARANTINED);
  });

  it('reports the credential unheld rather than reporting a kill it did not make', async () => {
    const outcome = await containment.contain({
      kind: CONTAINMENT_KIND.KILL,
      subjectId: 'agt_nobody',
      reason: 'wrong id',
      authorId: 'moise',
    });

    expect(outcome.contained).toBe(true);
    if (!outcome.contained) return;
    expect(outcome.action.effects.credentialsHeld).toBe(0);
  });

  it('leaves an agent nobody contained alone', async () => {
    const decision = await gateway.authorize(agentToken, { action: 'refund.create' });
    expect(decision.effect).toBe(DECISION_EFFECT.ALLOW);
    expect(AGENT_STATUS.ACTIVE).toBe('active');
  });
});
