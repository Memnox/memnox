import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { MEMNOX_HOME } from '../config/config';
import { HOLD_ANSWER, type HoldAnswer, type HoldRequest } from './hold';
import { writeJsonAtomic } from '../store/atomic-file';

/**
 * A held call, written down so something other than the terminal it started in can
 * answer it. That is the whole substrate for routed approvals: locally it is a second
 * terminal, and in the cloud it is a platform lead in Slack — the waiting side does not
 * know or care which.
 */

export const PENDING_DIR = 'pending';

export interface PendingApproval {
  id: string;
  request: HoldRequest;
  askedAt: string;
  /** When it stops being answerable. A hold with no end holds the agent for ever. */
  expiresAt: string;
  answer?: HoldAnswer;
  answeredAt?: string;
  /** Who answered. Recorded because "who approved this" is the first postmortem question. */
  answeredBy?: string;
}

export function pendingDirFor(home: string): string {
  return join(home, MEMNOX_HOME, PENDING_DIR);
}

function pathFor(home: string, id: string): string {
  return join(pendingDirFor(home), `${id}.json`);
}

export function pendingIdFor(request: HoldRequest, at: string): string {
  return `apr_${Date.parse(at).toString(36)}_${request.fingerprint.slice(0, 8)}`;
}

export class PendingApprovals {
  constructor(private readonly home: string) {}

  async raise(
    request: HoldRequest,
    askedAt: string,
    timeoutMs: number,
  ): Promise<PendingApproval> {
    const pending: PendingApproval = {
      id: pendingIdFor(request, askedAt),
      request,
      askedAt,
      expiresAt: new Date(Date.parse(askedAt) + timeoutMs).toISOString(),
    };
    await mkdir(pendingDirFor(this.home), { recursive: true, mode: 0o700 });
    await writeJsonAtomic(pathFor(this.home, pending.id), pending);
    return pending;
  }

  async read(id: string): Promise<PendingApproval | null> {
    try {
      return JSON.parse(
        await readFile(pathFor(this.home, id), 'utf8'),
      ) as PendingApproval;
    } catch {
      // Answered and cleared, or never raised. Both are "nothing to answer".
      return null;
    }
  }

  async list(moment: string): Promise<PendingApproval[]> {
    let names: string[];
    try {
      names = await readdir(pendingDirFor(this.home));
    } catch {
      // Nothing has ever been held here.
      return [];
    }

    const found: PendingApproval[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const pending = await this.read(name.slice(0, -5));
      if (pending === null) continue;
      // An expired hold is not answerable; showing it would invite answering it.
      if (pending.expiresAt <= moment) continue;
      found.push(pending);
    }
    return found.sort((a, b) => a.askedAt.localeCompare(b.askedAt));
  }

  /**
   * First answer wins. A second one is not an error: two people reaching for the same
   * approval is ordinary, and the loser needs to be told what already happened rather
   * than shown a failure.
   */
  async answer(
    id: string,
    answer: HoldAnswer,
    by: string,
    at: string,
  ): Promise<
    { answered: PendingApproval } | { alreadyAnswered: PendingApproval } | null
  > {
    const pending = await this.read(id);
    if (pending === null) return null;
    if (pending.answer !== undefined) return { alreadyAnswered: pending };

    const answered: PendingApproval = {
      ...pending,
      answer,
      answeredAt: at,
      answeredBy: by,
    };
    await writeJsonAtomic(pathFor(this.home, id), answered);
    return { answered };
  }

  async clear(id: string): Promise<void> {
    await rm(pathFor(this.home, id), { force: true });
  }
}

/**
 * Waits for somebody, somewhere, to answer. Polls rather than watches because the
 * answer may be written by another process, another terminal or — later — a sync
 * client, and a file is the one thing all three can agree on.
 */
export async function waitForAnswer(
  approvals: PendingApprovals,
  id: string,
  deadline: number,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
  intervalMs = 400,
): Promise<HoldAnswer | null> {
  while (now() < deadline) {
    const pending = await approvals.read(id);
    if (pending === null) return null;
    if (pending.answer !== undefined) return pending.answer;
    await sleep(intervalMs);
  }
  // Nobody answered in time. Denied, and said differently so it reads differently.
  return null;
}

export function describePending(pending: PendingApproval, moment: string): string {
  const waited = Math.round((Date.parse(moment) - Date.parse(pending.askedAt)) / 1000);
  const what =
    pending.request.target === undefined
      ? pending.request.operation
      : `${pending.request.operation} ${pending.request.target}`;
  return `${pending.id}  ${pending.request.agent} wants to ${what}  (${waited}s ago)`;
}

export { HOLD_ANSWER };
