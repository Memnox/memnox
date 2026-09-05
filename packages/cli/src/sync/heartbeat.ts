import { readFile } from 'node:fs/promises';
import { SqliteEventStore } from '@memnox/core';
import { readAccount } from './account';
import { orgPolicyPath, PULL_OUTCOME, pullBundle, type PullResult } from './bundle';
import { CloudUnreachable } from './client';
import { pushEvents, PUSH_OUTCOME, type PushResult } from './push';
import { callCloud } from './client';

/**
 * One pass: pull the rules, send what happened, say you are alive.
 *
 * Pull first, always. A machine that has just been given a stricter rule set
 * should be governed by it before it reports anything it did under the old one.
 */

/** Often enough that a new rule lands in a minute; an unchanged bundle is a 304. */
const HEARTBEAT_MS = 60_000;

/** Where it backs off to while the control plane is unreachable. */
const BACKOFF_MS = 15 * 60_000;

export interface Pass {
  pull?: PullResult;
  push?: PushResult;
  /** Set when nothing could be reached, which is not an error worth printing. */
  unreachable?: boolean;
  /** True once the credential is gone: stop until somebody logs in again. */
  revoked?: boolean;
}

export async function onePass(home: string): Promise<Pass> {
  const account = await readAccount(home);
  // Not logged in: no call is made at all, which is the whole promise.
  if (account === null) return {};

  try {
    const pull = await pullBundle(home, account, await heldHash(home));
    if (pull.outcome === PULL_OUTCOME.REVOKED) return { pull, revoked: true };

    const ledger = SqliteEventStore.forHome(home);
    let push: PushResult;
    try {
      push = await pushEvents(home, account, ledger);
    } finally {
      ledger.close();
    }
    if (push.outcome === PUSH_OUTCOME.REVOKED) return { pull, push, revoked: true };

    await beat(home, account, pull);
    return { pull, push };
  } catch (err) {
    if (err instanceof CloudUnreachable) return { unreachable: true };
    throw err;
  }
}

/**
 * What this machine is running and which bundle it has applied.
 *
 * Reported after the bundle is in place rather than after it arrives: the
 * console's "which machines are behind" is only true if this says applied.
 */
async function beat(
  home: string,
  account: Awaited<ReturnType<typeof readAccount>>,
  pull: PullResult,
): Promise<void> {
  if (account === null) return;
  const applied =
    pull.outcome === PULL_OUTCOME.APPLIED ? pull.hash : await heldHash(home);
  await callCloud({
    baseUrl: account.baseUrl,
    path: `/v1/workspaces/${account.workspaceId}/machines/${account.machineId}/heartbeat`,
    method: 'POST',
    token: account.token,
    body: applied === undefined ? {} : { bundleHashApplied: applied },
  });
}

/** The hash of what is already on disk, so an unchanged bundle costs one 304. */
async function heldHash(home: string): Promise<string | undefined> {
  try {
    const document = JSON.parse(await readFile(orgPolicyPath(home), 'utf8')) as {
      bundleHash?: string;
    };
    return document.bundleHash;
  } catch {
    return undefined; // Nothing pulled yet.
  }
}

interface LoopSeams {
  sleep?: (ms: number) => Promise<void>;
  pass?: (home: string) => Promise<Pass>;
  log?: (message: string) => void;
}

/**
 * The loop the daemon runs. Stops on a revocation and on nothing else — an
 * unreachable control plane backs off and keeps trying, because the ordinary
 * reason for one is a closed laptop lid.
 */
export async function syncLoop(
  home: string,
  running: () => boolean,
  seams: LoopSeams = {},
): Promise<void> {
  const sleep = seams.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const pass = seams.pass ?? onePass;

  while (running()) {
    let result: Pass;
    try {
      result = await pass(home);
    } catch (err) {
      // A pass that throws must not end the daemon; the gate is what matters.
      seams.log?.(err instanceof Error ? err.message : String(err));
      await sleep(BACKOFF_MS);
      continue;
    }
    if (result.revoked === true) {
      seams.log?.('this machine has been revoked; the rules it holds still apply');
      return;
    }
    await sleep(result.unreachable === true ? BACKOFF_MS : HEARTBEAT_MS);
  }
}
