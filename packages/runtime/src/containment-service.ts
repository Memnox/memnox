import { randomUUID } from 'node:crypto';
import type {
  ContainmentAction,
  ContainmentEffects,
  ContainmentKind,
  EnvironmentModes,
  InstallRef,
  Logger,
  SeamStore,
} from '@memnox/core';
import {
  CONTAINMENT_KIND,
  EMPTY_CONTAINMENT_EFFECTS,
  ENFORCEMENT_MODE,
  requiresRestorePath,
} from '@memnox/core';
import type { CapabilityBroker } from './capability-broker';

export const CONTAINMENT_ACTION = 'governance.containment';

export const CONTAINMENT_REFUSAL = {
  NO_REASON: 'containment needs a reason on the record',
  NO_SUBJECT: 'kill and quarantine name one agent',
  NO_RESTORE: 'panic needs a restore path before it is expressible',
} as const;

/** Every install this action has to reach, and when each was last heard from. */
export interface InstallDirectory {
  list(): Promise<InstallRef[]>;
  /** Whether the install acknowledged the action. Unreachable is not a failure to hide. */
  deliver(install: InstallRef, action: ContainmentAction): Promise<boolean>;
}

/** A single install: this machine, always reachable, because it is this process. */
export class LocalInstallDirectory implements InstallDirectory {
  constructor(private readonly hostLabel: string) {}

  async list(): Promise<InstallRef[]> {
    return [{ id: 'local', hostLabel: this.hostLabel }];
  }

  async deliver(): Promise<boolean> {
    return true;
  }
}

export interface ContainmentRequest {
  kind: ContainmentKind;
  subjectId?: string;
  reason: string;
  authorId: string;
  restorePath?: string;
}

export type ContainmentOutcome =
  { contained: true; action: ContainmentAction } | { contained: false; reason: string };

export interface ContainmentDeps {
  seams: SeamStore;
  broker: CapabilityBroker;
  installs: InstallDirectory;
  logger: Logger;
  /** Raising every environment to enforce is what panic actually does. */
  raiseEnvironments: (modes: EnvironmentModes) => Promise<number>;
  clock?: () => Date;
}

/**
 * Kill revokes leases, closes seams and cancels pending work for one agent. Quarantine
 * restricts rather than refuses, which keeps an agent debuggable instead of dead. Panic
 * is organization-wide and needs a way back before it is expressible at all.
 */
export class ContainmentService {
  private readonly clock: () => Date;

  constructor(private readonly deps: ContainmentDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  async contain(request: ContainmentRequest): Promise<ContainmentOutcome> {
    const refusal = this.refuse(request);
    if (refusal !== null) return { contained: false, reason: refusal };

    const at = this.clock().toISOString();
    const effects: ContainmentEffects = { ...EMPTY_CONTAINMENT_EFFECTS };

    if (request.subjectId !== undefined) {
      effects.leasesRevoked = await this.deps.broker.revokeAllFor(request.subjectId);
      effects.seamsClosed = await this.closeSeams(request.kind, request.subjectId);
    }
    if (request.kind === CONTAINMENT_KIND.PANIC) {
      effects.environmentsRaised = await this.deps.raiseEnvironments({
        default: ENFORCEMENT_MODE.ENFORCE,
      });
    }

    const action: ContainmentAction = {
      id: randomUUID(),
      workspaceId: 'local',
      kind: request.kind,
      ...(request.subjectId === undefined ? {} : { subjectId: request.subjectId }),
      reason: request.reason,
      authorId: request.authorId,
      at,
      effects,
      unreached: [],
    };

    /* A killed agent on a laptop that is asleep is not killed yet. The action records
       which installs it reached and which it did not, because a kill reporting success
       while one machine is offline is the worst possible lie. */
    const unreached: InstallRef[] = [];
    for (const install of await this.deps.installs.list()) {
      let reached = false;
      try {
        reached = await this.deps.installs.deliver(install, action);
      } catch (err) {
        this.deps.logger.error(
          `containment could not reach ${install.hostLabel}: ${String(err)}`,
        );
      }
      if (reached) effects.installsReached += 1;
      else unreached.push(install);
    }

    return { contained: true, action: { ...action, effects, unreached } };
  }

  /** Quarantine is read-only: seams stay installed and stop issuing, rather than closing. */
  private async closeSeams(kind: ContainmentKind, subjectId: string): Promise<number> {
    const seams = await this.deps.seams.listByAgent(subjectId);
    if (kind === CONTAINMENT_KIND.QUARANTINE) {
      for (const seam of seams) {
        await this.deps.seams.save({ ...seam, mode: ENFORCEMENT_MODE.ENFORCE });
      }
      return 0;
    }
    for (const seam of seams) {
      await this.deps.seams.save({ ...seam, mode: ENFORCEMENT_MODE.OFF });
    }
    return seams.length;
  }

  private refuse(request: ContainmentRequest): string | null {
    if (request.reason.trim().length === 0) return CONTAINMENT_REFUSAL.NO_REASON;
    const namesAgent =
      request.kind === CONTAINMENT_KIND.KILL ||
      request.kind === CONTAINMENT_KIND.QUARANTINE;
    if (namesAgent && request.subjectId === undefined) {
      return CONTAINMENT_REFUSAL.NO_SUBJECT;
    }
    if (requiresRestorePath(request.kind) && request.restorePath === undefined) {
      return CONTAINMENT_REFUSAL.NO_RESTORE;
    }
    return null;
  }
}
