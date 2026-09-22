import { readAccount } from '../sync/account';
import type { Lease, LeaseHolder } from './lease';
import type { WrittenRegion } from './written-region';

/**
 * The half of a lease a laptop structurally cannot hold.
 *
 * One machine's register answers "is another session here writing this", and that is
 * the whole question when there is one machine. Two machines on one repository —
 * Hermes on a VPS and Claude Code on a laptop — need the register somewhere both can
 * see, and only the control plane is somewhere both can see.
 *
 * Three rules make this safe to put on the decision path.
 *
 * **Unreachable is not held.** A lease is coordination and not safety, so a network
 * that hiccups must not stop work. Every failure here reads as "nobody could tell me",
 * and the caller proceeds on the local register alone. A shared lease that blocked an
 * agent whenever the wifi dropped is one people would turn off within a day.
 *
 * **No account, no call.** With no account file this makes no network call at all,
 * which is the same promise the rest of the runtime makes.
 *
 * **Bounded.** One short request. The waiting, if there is any, happens on the side
 * that can give up — which is never this one.
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
    /* What in the file is being written, where the caller worked it out. The
       control plane narrows a collision on it and takes the whole file
       without it, so absent is what every lease meant before this. */
    region?: WrittenRegion,
  ): Promise<SharedTake>;
  release(id: string, holder: LeaseHolder): Promise<void>;
  /**
   * Everything this session holds in the workspace, given back when it ends. The
   * write path keeps no ids for what it took, so without this a session that ended
   * left its files held on every other machine until the window ran out.
   */
  releaseSession(holder: LeaseHolder): Promise<void>;
  /**
   * Everything this session holds in the workspace, kept for another window,
   * because it is still working. Best effort: a renewal that does not land is a
   * hold that lapses a few minutes early.
   */
  renewSession(holder: LeaseHolder, minutes: number): Promise<void>;
}

type Fetcher = typeof globalThis.fetch;

/** The control plane's register, over the same account the rest of sync uses. */
export class CloudLeases implements SharedLeases {
  constructor(
    private readonly home: string,
    private readonly fetcher: Fetcher = globalThis.fetch,
    private readonly timeoutMs: number = SHARED_LEASE_TIMEOUT_MS,
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

    const body = {
      path,
      holder: {
        agent: holder.agent,
        session: holder.sessionId,
        machine: account.machineId,
      },
      ttlMs: minutes * 60_000,
      activity: `taken on ${account.machineId}`,
      /* Sent only where there is something to send. An empty list would claim
         the session knows it is writing nothing, where the truth is that
         nothing was worked out. */
      ...(region === undefined || region.lines.length === 0
        ? {}
        : { lines: region.lines }),
      ...(region === undefined || region.symbols.length === 0
        ? {}
        : { symbols: region.symbols }),
    };

    const response = await this.post(
      account.baseUrl,
      `/v1/workspaces/${account.workspaceId}/leases`,
      account.token,
      body,
    );
    if (response === null) {
      return {
        outcome: SHARED_OUTCOME.UNKNOWN,
        because: 'the control plane did not answer',
      };
    }

    if (response.status === 201 || response.status === 200) {
      return { outcome: SHARED_OUTCOME.TAKEN, lease: response.body as Lease };
    }
    if (response.status === 409) {
      const conflict = response.body as {
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
      };
      const held = conflict.holding;
      const lines = held === undefined || !Array.isArray(held.lines) ? [] : held.lines;
      const symbols =
        held === undefined || !Array.isArray(held.symbols) ? [] : held.symbols;
      return {
        outcome: SHARED_OUTCOME.HELD_BY_ANOTHER,
        ...(lines.length === 0 && symbols.length === 0
          ? {}
          : { region: { lines, symbols } }),
        ...(held === undefined || typeof held.takenAt !== 'string'
          ? {}
          : { since: held.takenAt }),
        ...(held === undefined ? {} : lastActiveOf(held.renewedAt, held.takenAt)),
        ...(held === undefined || typeof held.expiresAt !== 'string'
          ? {}
          : { until: held.expiresAt }),
        ...(held === undefined || typeof held.id !== 'string'
          ? {}
          : { leaseId: held.id }),
        holder: conflict.holding?.holder?.agent ?? 'another agent',
        ...(conflict.holding?.holder?.machine === undefined
          ? {}
          : { machine: conflict.holding.holder.machine }),
        path: conflict.holding?.path ?? path,
        message: conflict.message ?? 'another machine holds that path',
      };
    }
    /* Anything else — the workspace does not have shared leases, the token was
       revoked, the route moved — is "nobody could tell me" rather than "held". */
    return {
      outcome: SHARED_OUTCOME.UNKNOWN,
      because: `the control plane answered ${response.status}`,
    };
  }

  async release(id: string, holder: LeaseHolder): Promise<void> {
    const account = await readAccount(this.home);
    if (account === null) return;
    await this.post(
      account.baseUrl,
      `/v1/workspaces/${account.workspaceId}/leases/${id}`,
      account.token,
      { holder: { agent: holder.agent, session: holder.sessionId } },
      'DELETE',
    );
  }

  async renewSession(holder: LeaseHolder, minutes: number): Promise<void> {
    const account = await readAccount(this.home);
    if (account === null) return;
    await this.post(
      account.baseUrl,
      `/v1/workspaces/${account.workspaceId}/leases/renew-session`,
      account.token,
      {
        holder: { agent: holder.agent, session: holder.sessionId },
        ttlMs: minutes * 60_000,
      },
    );
  }

  /**
   * A person freeing lines another session holds, on the record.
   *
   * Taken over with the person's reason and then let go at once, so the lines are
   * free for whichever agent was waiting rather than held by the terminal that
   * freed them. The takeover row keeps who did it and why: an override nobody can
   * find later is only a slower allow.
   */
  async free(id: string, by: LeaseHolder, reason: string): Promise<FreeOutcome> {
    const account = await readAccount(this.home);
    if (account === null) return FREE_OUTCOME.NOT_ENROLLED;
    const holder = { agent: by.agent, session: by.sessionId };
    const taken = await this.post(
      account.baseUrl,
      `/v1/workspaces/${account.workspaceId}/leases/${encodeURIComponent(id)}/take-over`,
      account.token,
      { holder, reason },
    );
    if (taken === null) return FREE_OUTCOME.UNREACHABLE;
    if (taken.status === 404 || taken.status === 409) return FREE_OUTCOME.GONE;
    if (taken.status !== 200 && taken.status !== 201) return FREE_OUTCOME.REFUSED;
    const lease = taken.body as { id?: unknown };
    if (typeof lease.id === 'string') {
      await this.post(
        account.baseUrl,
        `/v1/workspaces/${account.workspaceId}/leases/${encodeURIComponent(lease.id)}`,
        account.token,
        { holder },
        'DELETE',
      );
    }
    return FREE_OUTCOME.FREED;
  }

  async releaseSession(holder: LeaseHolder): Promise<void> {
    const account = await readAccount(this.home);
    if (account === null) return;
    await this.post(
      account.baseUrl,
      `/v1/workspaces/${account.workspaceId}/leases/release`,
      account.token,
      { holder: { agent: holder.agent, session: holder.sessionId } },
    );
  }

  private async post(
    baseUrl: string,
    path: string,
    token: string,
    body: unknown,
    method = 'POST',
  ): Promise<{ status: number; body: unknown } | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetcher(`${baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      return {
        status: response.status,
        body: text === '' ? null : safeJson(text),
      };
    } catch {
      // Unreachable, aborted, or not JSON. All of them mean nobody could tell us.
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The last sign of life: a renewal where there was one, and the take otherwise. */
function lastActiveOf(renewedAt: unknown, takenAt: unknown): { lastActive?: string } {
  if (typeof renewedAt === 'string') return { lastActive: renewedAt };
  if (typeof takenAt === 'string') return { lastActive: takenAt };
  return {};
}
