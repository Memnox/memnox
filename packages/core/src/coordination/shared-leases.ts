import { readAccount, type Account } from '../sync/account';
import { HTTP } from '../sync/http-status';
import {
  parseReplyBody,
  runControlPlaneRequest,
  type Fetcher,
} from '../sync/control-plane-request';
import type { Lease, LeaseHolder } from './lease';
import type { WrittenRegion } from './written-region';
import { minutesToMs } from '../domain/time';

/**
 * The register two machines on one repository can both see, held by the control plane.
 * Unreachable is not held, no account means no call, and every request is bounded.
 */

/** Milliseconds. An interceptor runs on every write; a slow control plane must not be felt. */
export const SHARED_LEASE_TIMEOUT_MS = 1_500;

export const SHARED_OUTCOME = {
  TAKEN: 'taken',
  HELD_BY_ANOTHER: 'held_by_another',
  /** Not enrolled, unreachable, too slow, or the workspace does not have the feature. */
  UNKNOWN: 'unknown',
} as const;

export type SharedOutcome = (typeof SHARED_OUTCOME)[keyof typeof SHARED_OUTCOME];

export type SharedTake =
  | { outcome: typeof SHARED_OUTCOME.TAKEN; lease: Lease }
  | {
      outcome: typeof SHARED_OUTCOME.HELD_BY_ANOTHER;
      /** Enough to name the holder. A refusal that will not say gets forced every time. */
      holder: string;
      machine?: string;
      path: string;
      message: string;
      /** What in the file the holder is writing, where it said. */
      region?: WrittenRegion;
      /** When the holder took it. */
      since?: string;
      /** When the holder last did anything, which is when it last renewed. */
      lastActive?: string;
      /** When it lapses if the holder stays quiet. */
      until?: string;
      /** The lease itself, so a person can free it by name. */
      leaseId?: string;
    }
  | { outcome: typeof SHARED_OUTCOME.UNKNOWN; because: string };

export const FREE_OUTCOME = {
  FREED: 'freed',
  /** Nobody holds it any more: it lapsed, was released, or never existed. */
  GONE: 'gone',
  NOT_ENROLLED: 'not-enrolled',
  UNREACHABLE: 'unreachable',
  /** The control plane answered and said no, in its own words elsewhere. */
  REFUSED: 'refused',
} as const;

export type FreeOutcome = (typeof FREE_OUTCOME)[keyof typeof FREE_OUTCOME];

export interface SharedLeases {
  take(
    path: string,
    holder: LeaseHolder,
    minutes: number,
    // What in the file is being written, where known; absent claims the whole file.
    region?: WrittenRegion,
  ): Promise<SharedTake>;
  release(id: string, holder: LeaseHolder): Promise<void>;
  /** Everything this session holds, given back when it ends, since the write path keeps no ids. */
  releaseSession(holder: LeaseHolder): Promise<void>;
  /** Everything this session holds, kept for another window. A renewal that misses lapses early. */
  renewSession(holder: LeaseHolder, minutes: number): Promise<void>;
}

/** The control plane's register, over the same account the rest of sync uses. */
export class CloudLeases implements SharedLeases {
  constructor(
    private readonly home: string,
    private readonly fetcher: Fetcher = globalThis.fetch,
    private readonly timeoutMs: number = SHARED_LEASE_TIMEOUT_MS,
    // The repository's name, so the console can say who else is working in it.
    private readonly repository?: string,
  ) {}

  async take(
    path: string,
    holder: LeaseHolder,
    minutes: number,
    region?: WrittenRegion,
  ): Promise<SharedTake> {
    const account = await readAccount(this.home);
    if (account === null) {
      return { outcome: SHARED_OUTCOME.UNKNOWN, because: 'this machine is not enrolled' };
    }
    const response = await this.send(account, {
      path: `/v1/workspaces/${account.workspaceId}/leases`,
      body: takeBody(
        { path, holder, minutes, region, repository: this.repository },
        account.machineId,
      ),
    });
    if (response === null) {
      return {
        outcome: SHARED_OUTCOME.UNKNOWN,
        because: 'the control plane did not answer',
      };
    }
    if (response.status === HTTP.CREATED || response.status === HTTP.OK) {
      // The control plane answers with the lease it recorded, in this vocabulary.
      return { outcome: SHARED_OUTCOME.TAKEN, lease: response.body as Lease };
    }
    if (response.status === HTTP.CONFLICT) return heldByAnother(response.body, path);
    // No shared leases, a revoked token or a moved route all mean nobody could tell.
    return {
      outcome: SHARED_OUTCOME.UNKNOWN,
      because: `the control plane answered ${response.status}`,
    };
  }

  async release(id: string, holder: LeaseHolder): Promise<void> {
    const account = await readAccount(this.home);
    if (account === null) return;
    await this.send(account, {
      path: `/v1/workspaces/${account.workspaceId}/leases/${id}`,
      body: { holder: sessionHolder(holder) },
      method: 'DELETE',
    });
  }

  async renewSession(holder: LeaseHolder, minutes: number): Promise<void> {
    const account = await readAccount(this.home);
    if (account === null) return;
    await this.send(account, {
      path: `/v1/workspaces/${account.workspaceId}/leases/renew-session`,
      body: { holder: sessionHolder(holder), ttlMs: minutesToMs(minutes) },
    });
  }

  /**
   * A person freeing lines another session holds, on the record. Taken over and released
   * at once, so the lines go to whoever was waiting rather than to this terminal.
   */
  async free(id: string, by: LeaseHolder, reason: string): Promise<FreeOutcome> {
    const account = await readAccount(this.home);
    if (account === null) return FREE_OUTCOME.NOT_ENROLLED;
    const holder = sessionHolder(by);
    const taken = await this.send(account, {
      path: `/v1/workspaces/${account.workspaceId}/leases/${encodeURIComponent(id)}/take-over`,
      body: { holder, reason },
    });
    if (taken === null) return FREE_OUTCOME.UNREACHABLE;
    if (taken.status === HTTP.NOT_FOUND || taken.status === HTTP.CONFLICT) {
      return FREE_OUTCOME.GONE;
    }
    if (taken.status !== HTTP.OK && taken.status !== HTTP.CREATED) {
      return FREE_OUTCOME.REFUSED;
    }
    // Read defensively: the body is whatever the control plane sent.
    const lease = (taken.body ?? {}) as { id?: unknown };
    if (typeof lease.id === 'string') {
      await this.send(account, {
        path: `/v1/workspaces/${account.workspaceId}/leases/${encodeURIComponent(lease.id)}`,
        body: { holder },
        method: 'DELETE',
      });
    }
    return FREE_OUTCOME.FREED;
  }

  async releaseSession(holder: LeaseHolder): Promise<void> {
    const account = await readAccount(this.home);
    if (account === null) return;
    await this.send(account, {
      path: `/v1/workspaces/${account.workspaceId}/leases/release`,
      body: { holder: sessionHolder(holder) },
    });
  }

  private async send(
    account: Account,
    request: { path: string; body: unknown; method?: 'POST' | 'DELETE' },
  ): Promise<{ status: number; body: unknown } | null> {
    const reply = await runControlPlaneRequest({
      account,
      ...request,
      fetcher: this.fetcher,
      timeoutMs: this.timeoutMs,
    });
    return reply === null
      ? null
      : { status: reply.status, body: parseReplyBody(reply.text) };
  }
}

function sessionHolder(holder: LeaseHolder): { agent: string; session: string } {
  return { agent: holder.agent, session: holder.sessionId };
}

interface SharedTakeRequest {
  path: string;
  holder: LeaseHolder;
  minutes: number;
  region: WrittenRegion | undefined;
  repository: string | undefined;
}

function takeBody(
  request: SharedTakeRequest,
  machineId: string,
): Record<string, unknown> {
  const { path, holder, minutes, region, repository } = request;
  // Only what is known: an empty list would claim the session writes nothing.
  const lines =
    region === undefined || region.lines.length === 0 ? {} : { lines: region.lines };
  const symbols =
    region === undefined || region.symbols.length === 0
      ? {}
      : { symbols: region.symbols };
  return {
    path,
    holder: { ...sessionHolder(holder), machine: machineId },
    ttlMs: minutesToMs(minutes),
    activity: `taken on ${machineId}`,
    ...lines,
    ...symbols,
    ...(repository === undefined ? {} : { repository }),
  };
}

/** The lease in the way as the control plane described it, in its own field names. */
interface ConflictBody {
  message?: string;
  holding?: {
    id?: string;
    holder?: { agent?: string; machine?: string };
    path?: string;
    takenAt?: string;
    renewedAt?: string;
    expiresAt?: string;
    lines?: WrittenRegion['lines'];
    symbols?: string[];
  };
}

function heldByAnother(body: unknown, path: string): SharedTake {
  // Read defensively below: every field is checked before it is trusted.
  const conflict = (body ?? {}) as ConflictBody;
  const held = conflict.holding ?? {};
  const lines = Array.isArray(held.lines) ? held.lines : [];
  const symbols = Array.isArray(held.symbols) ? held.symbols : [];
  return {
    outcome: SHARED_OUTCOME.HELD_BY_ANOTHER,
    ...(lines.length === 0 && symbols.length === 0 ? {} : { region: { lines, symbols } }),
    ...(typeof held.takenAt === 'string' ? { since: held.takenAt } : {}),
    ...(conflict.holding === undefined ? {} : lastActiveOf(held.renewedAt, held.takenAt)),
    ...(typeof held.expiresAt === 'string' ? { until: held.expiresAt } : {}),
    ...(typeof held.id === 'string' ? { leaseId: held.id } : {}),
    holder: held.holder?.agent ?? 'another agent',
    ...(held.holder?.machine === undefined ? {} : { machine: held.holder.machine }),
    path: held.path ?? path,
    message: conflict.message ?? 'another machine holds that path',
  };
}

/** The last sign of life: a renewal where there was one, and the take otherwise. */
function lastActiveOf(renewedAt: unknown, takenAt: unknown): { lastActive?: string } {
  if (typeof renewedAt === 'string') return { lastActive: renewedAt };
  if (typeof takenAt === 'string') return { lastActive: takenAt };
  return {};
}
