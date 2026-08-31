import {
  ENFORCEMENT_MODE,
  newSeam,
  SEAM_KIND,
  type EnforcementMode,
  type Logger,
  type Seam,
  type SeamKind,
  type SeamStore,
  type SeamUnhealthyBehaviour,
} from '@memnox/core';

const VALID_SEAM_KINDS: readonly string[] = Object.values(SEAM_KIND);

export function isSeamKind(value: unknown): value is SeamKind {
  return typeof value === 'string' && VALID_SEAM_KINDS.includes(value);
}

export interface SeamRegistration {
  agentId: string;
  kind: SeamKind;
  mode?: EnforcementMode;
  /** Action globs this seam actually sees. */
  covers?: readonly string[];
  /** What it cannot see. Empty is a claim, and almost always a false one. */
  blindTo?: readonly string[];
  /** The harden step that installed it, so uninstalling is one command. */
  installedBy?: string;
  whenUnhealthy?: SeamUnhealthyBehaviour;
}

export interface SeamServiceDeps {
  store: SeamStore;
  logger: Logger;
  /** Injected so a registration is reproducible; never read off a clock inside. */
  now?: () => string;
}

/**
 * One seam per agent per kind. The id is derived from both, so a proxy that restarts
 * updates its row rather than adding a second one — a fleet counting the same seam
 * twice reports coverage it does not have.
 */
export function seamIdFor(agentId: string, kind: SeamKind): string {
  return `seam_${agentId}_${kind}`;
}

/**
 * Registration is a heartbeat as well as an install: `lastSeenAt` moves every time,
 * which is what makes a seam that quietly stopped reporting distinguishable from one
 * nobody installed.
 */
export class SeamService {
  constructor(private readonly deps: SeamServiceDeps) {}

  async register(input: SeamRegistration): Promise<Seam> {
    const now = this.now();
    const existing = await this.find(input.agentId, input.kind);

    const seam = newSeam({
      id: seamIdFor(input.agentId, input.kind),
      agentId: input.agentId,
      kind: input.kind,
      mode: input.mode ?? existing?.mode ?? ENFORCEMENT_MODE.OBSERVE,
      covers: [...(input.covers ?? existing?.covers ?? [])],
      blindTo: [...(input.blindTo ?? existing?.blindTo ?? [])],
      ...(input.installedBy === undefined
        ? existing?.installedBy === undefined
          ? {}
          : { installedBy: existing.installedBy }
        : { installedBy: input.installedBy }),
      lastSeenAt: now,
      ...(input.whenUnhealthy === undefined
        ? existing === undefined
          ? {}
          : { whenUnhealthy: existing.whenUnhealthy }
        : { whenUnhealthy: input.whenUnhealthy }),
    });

    await this.deps.store.save(seam);
    return seam;
  }

  async list(): Promise<Seam[]> {
    return this.deps.store.list();
  }

  async listByAgent(agentId: string): Promise<Seam[]> {
    return this.deps.store.listByAgent(agentId);
  }

  /** Uninstalling a seam removes its claim to coverage, which is the point. */
  async remove(id: string): Promise<boolean> {
    return this.deps.store.remove(id);
  }

  private async find(agentId: string, kind: SeamKind): Promise<Seam | undefined> {
    try {
      const seams = await this.deps.store.listByAgent(agentId);
      return seams.find((seam) => seam.kind === kind);
    } catch (err) {
      // An unreadable store must not stop a seam declaring itself; it re-registers.
      this.deps.logger.error(`seam lookup failed for ${agentId}/${kind}: ${String(err)}`);
      return undefined;
    }
  }

  private now(): string {
    const clock = this.deps.now;
    return clock === undefined ? new Date().toISOString() : clock();
  }
}
