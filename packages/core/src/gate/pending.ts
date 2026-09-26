import { join } from 'node:path';
import { MEMNOX_HOME } from '../config/config';
import { describeHeldCall, type HoldAnswer, type HoldRequest } from './hold';
import { msToSeconds } from '../domain/time';
import { JsonRecordDir } from '../store/json-records';

/**
 * A held call, written down so something other than its own terminal can answer it:
 * a second terminal locally, or the control plane. The waiting side does not know which.
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
  /** Who answered, because "who approved this" is the first postmortem question. */
  answeredBy?: string;
  /**
   * Where it may be answered: `session` stays on this machine, `both` reaches the
   * workspace too. Absent is every call raised before the field, which the workspace saw.
   */
  route?: 'session' | 'both';
  /** When the agent was told the answer, so it is told once. */
  toldAgentAt?: string;
}

/** Whether the workspace is sent this call, so a person can answer it from chat. */
export function goesToWorkspace(pending: PendingApproval): boolean {
  return pending.route !== 'session';
}

export type AnswerOutcome =
  { answered: PendingApproval } | { alreadyAnswered: PendingApproval } | null;

export function pendingDirFor(home: string): string {
  return join(home, MEMNOX_HOME, PENDING_DIR);
}

export function pendingIdFor(request: HoldRequest, at: string): string {
  return `apr_${Date.parse(at).toString(36)}_${request.fingerprint.slice(0, 8)}`;
}

export class PendingApprovals {
  private readonly records: JsonRecordDir<PendingApproval>;

  constructor(home: string) {
    this.records = new JsonRecordDir(pendingDirFor(home));
  }

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
    await this.records.write(pending.id, pending);
    return pending;
  }

  /** Rewrites a call already raised, as it is given. */
  keep(pending: PendingApproval): Promise<void> {
    return this.records.write(pending.id, pending);
  }

  /** Null when it was answered and cleared, or never raised. */
  read(id: string): Promise<PendingApproval | null> {
    return this.records.read(id);
  }

  async list(moment: string): Promise<PendingApproval[]> {
    const found = await this.records.all();
    return (
      found
        // An expired hold is not answerable, and showing it would invite answering it.
        .filter((pending) => pending.expiresAt > moment)
        .sort((a, b) => a.askedAt.localeCompare(b.askedAt))
    );
  }

  /** First answer wins, and a second is told what already happened rather than failed. */
  async answer(
    id: string,
    answer: HoldAnswer,
    by: string,
    at: string,
  ): Promise<AnswerOutcome> {
    const pending = await this.read(id);
    if (pending === null) return null;
    if (pending.answer !== undefined) return { alreadyAnswered: pending };

    const answered: PendingApproval = {
      ...pending,
      answer,
      answeredAt: at,
      answeredBy: by,
    };
    await this.records.write(id, answered);
    return { answered };
  }

  clear(id: string): Promise<void> {
    return this.records.remove(id);
  }
}

/** Often enough that an answer lands while somebody is still watching for it. */
const ANSWER_POLL_MS = 400;

export interface WaitForAnswerInput {
  approvals: PendingApprovals;
  id: string;
  /** Epoch milliseconds, on the same clock as `now`. */
  deadline: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
}

function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls rather than watches, because the answer may come from another process, another
 * terminal or a sync client, and a file is the one thing all three agree on.
 */
export async function waitForAnswer(
  input: WaitForAnswerInput,
): Promise<HoldAnswer | null> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? sleepFor;
  while (now() < input.deadline) {
    const pending = await input.approvals.read(input.id);
    if (pending === null) return null;
    if (pending.answer !== undefined) return pending.answer;
    await sleep(input.intervalMs ?? ANSWER_POLL_MS);
  }
  return null;
}

export function describePending(pending: PendingApproval, moment: string): string {
  const waited = msToSeconds(Date.parse(moment) - Date.parse(pending.askedAt));
  const what = describeHeldCall(pending.request);
  return `${pending.id}  ${pending.request.agent} wants to ${what}  (${waited}s ago)`;
}
