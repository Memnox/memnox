import {
  HTTP,
  isCredentialRefused,
  markWorkspaceMemorySynced,
  parseWorkspaceMemory,
  readAccount,
  readWorkspaceMemory,
  secondsToMs,
  writeWorkspaceMemory,
  type Account,
} from '@memnox/core';

import { callCloud, CloudUnreachable } from './client';

/**
 * What the workspace has settled, pulled beside the rules and kept where a hook reads it,
 * and the brief for what an agent is about to touch. Neither is on the decision path: a
 * failure keeps what this machine already held and never stops a pass or an agent.
 */

export const MEMORY_OUTCOME = {
  UNCHANGED: 'unchanged',
  APPLIED: 'applied',
  /** Unreadable, refused or unreachable. What was pulled before stays. */
  KEPT: 'kept',
} as const;

export type MemoryOutcome = (typeof MEMORY_OUTCOME)[keyof typeof MEMORY_OUTCOME];

export interface MemoryPull {
  outcome: MemoryOutcome;
  facts?: number;
}

/** Shorter than a pass, since an agent may be waiting on the answer in its session. */
const BRIEF_TIMEOUT_MS = secondsToMs(5);

/** The control plane's own ceiling on one brief. */
const MOST_BRIEF_RESOURCES = 50;

/** One conditional GET. An unchanged memory costs a 304 and moves `syncedAt` forward. */
export async function pullMemory(
  home: string,
  account: Account,
  now: () => Date = () => new Date(),
): Promise<MemoryPull> {
  const held = await readWorkspaceMemory(home);
  let answer;
  try {
    answer = await callCloud<unknown>({
      baseUrl: account.baseUrl,
      path: `/v1/workspaces/${account.workspaceId}/memory`,
      token: account.token,
      ...(held === null ? {} : { ifNoneMatch: held.hash }),
    });
  } catch (err) {
    if (err instanceof CloudUnreachable) return { outcome: MEMORY_OUTCOME.KEPT };
    throw err;
  }
  const syncedAt = now().toISOString();
  if (answer.status === HTTP.NOT_MODIFIED && held !== null) {
    await markWorkspaceMemorySynced(home, syncedAt);
    return { outcome: MEMORY_OUTCOME.UNCHANGED };
  }
  const memory =
    answer.status === HTTP.OK ? parseWorkspaceMemory(answer.body, syncedAt) : null;
  if (memory === null) return { outcome: MEMORY_OUTCOME.KEPT };
  await writeWorkspaceMemory(home, memory);
  return { outcome: MEMORY_OUTCOME.APPLIED, facts: memory.facts.length };
}

/**
 * The live brief from `POST :ws/context`, or null where this machine is not connected, was
 * let go, or could not reach the control plane in time. The caller falls back to what it holds.
 */
export async function fetchBrief(
  home: string,
  resources: readonly string[],
  repository?: string,
): Promise<unknown> {
  const account = await readAccount(home);
  if (account === null || account.revokedAt !== undefined) return null;
  try {
    const answer = await callCloud<unknown>({
      baseUrl: account.baseUrl,
      path: `/v1/workspaces/${account.workspaceId}/context`,
      method: 'POST',
      token: account.token,
      timeoutMs: BRIEF_TIMEOUT_MS,
      body: {
        resources: resources.slice(0, MOST_BRIEF_RESOURCES),
        ...(repository === undefined ? {} : { repository }),
      },
    });
    if (isCredentialRefused(answer.status) || answer.status !== HTTP.OK) return null;
    return answer.body ?? null;
  } catch (err) {
    if (err instanceof CloudUnreachable) return null;
    throw err;
  }
}
