import { beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_KIND,
  CONTAINMENT_KIND,
  ENFORCEMENT_MODE,
  SEAM_KIND,
  newSeam,
  type Capability,
  type EnvironmentModes,
  type InstallRef,
  type Seam,
  type SeamStore,
} from '@memnox/core';
import { PolicyEngine } from '@memnox/policy-engine';
import { ActionGateway } from '../src/action-gateway';
import { CapabilityBroker } from '../src/capability-broker';
import {
  ContainmentService,
  CONTAINMENT_REFUSAL,
  type InstallDirectory,
} from '../src/containment-service';
import { CONSOLE_LOGGER } from '../src/console-logger';
import { InMemoryApprovalStore } from '../src/stores/in-memory-approval-store';
import { InMemoryAuditLog } from '../src/stores/in-memory-audit-log';
import {
  InMemoryCapabilityStore,
  InMemoryLeaseStore,
} from '../src/stores/in-memory-capability-store';
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
  let leases: InMemoryLeaseStore;
  let raised: EnvironmentModes[];
  let agentId: string;

  beforeEach(async () => {
    seams = new MemorySeamStore();
    leases = new InMemoryLeaseStore();
    raised = [];
    const gateway = new ActionGateway({
      identityStore: new InMemoryIdentityStore(),
      auditLog: new InMemoryAuditLog(),
      approvalStore: new InMemoryApprovalStore(),
      policyEngine: new PolicyEngine([]),
    });
    const registered = await gateway.registerAgent('bot', AGENT_KIND.CUSTOM);
    agentId = registered.agent.id;

    const capabilities = new InMemoryCapabilityStore();
    const capability: Capability = {
      id: 'cap_1',
      agentId,
      operation: 'refund.create',
      scope: {},
      ttlSeconds: 300,
    };
    await capabilities.save(capability);
    const broker = new CapabilityBroker({
      capabilities,
      leases,
      gateway,
      logger: CONSOLE_LOGGER,
      clock: () => NOW,
    });
    await broker.issue(registered.token, {
      capabilityId: 'cap_1',
      target: 'cus_1',
      scope: {},
    });

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
      broker,
      installs: new PartialFleet(),
      logger: CONSOLE_LOGGER,
      raiseEnvironments: async (modes) => {
        raised.push(modes);
        return 1;
      },
      clock: () => NOW,
    });
  });

  it('kills one agent: leases revoked, seams closed, in one recorded action', async () => {
    const outcome = await containment.contain({
      kind: CONTAINMENT_KIND.KILL,
      subjectId: agentId,
      reason: 'it reached production',
      authorId: 'moise',
    });

    expect(outcome.contained).toBe(true);
    if (!outcome.contained) return;
    expect(outcome.action.effects.leasesRevoked).toBe(1);
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
    expect(await leases.listByAgent(agentId)).toSatisfy(
      (held: unknown[]) => held.length > 0,
    );
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
});
