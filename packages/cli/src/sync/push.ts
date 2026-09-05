import { createSign, sign as signBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MEMNOX_HOME, type EventSink, type MemnoxEvent } from '@memnox/core';
import type { Account } from './account';
import { callCloud } from './client';

/**
 * Sending what this machine did, in signed batches.
 *
 * Nothing here is on the decision path. The gate has already answered and the
 * row is already written; this only carries it, and a failure loses a send
 * rather than a verdict.
 */

const CURSOR_FILE = 'sync.json';
const OWNER_ONLY = 0o600;

/** The control plane refuses more than this per post; it says so in its own words. */
const BATCH = 500;

/**
 * How far back a resend reaches.
 *
 * The cursor is an optimisation, not the correctness: every event carries a
 * stable id and the control plane deduplicates on it, so an overlap costs a
 * comparison there and closes the gap a crash between "posted" and "recorded"
 * would otherwise leave.
 */
const OVERLAP_MS = 60_000;

interface Cursor {
  /** The `at` of the newest event known to have landed. */
  pushedThrough?: string;
  lastPushAt?: string;
}

export const PUSH_OUTCOME = {
  SENT: 'sent',
  NOTHING: 'nothing',
  REVOKED: 'revoked',
  /** The control plane would not take it. The rows stay; the next pass retries. */
  REFUSED: 'refused',
} as const;

export type PushOutcome = (typeof PUSH_OUTCOME)[keyof typeof PUSH_OUTCOME];

export interface PushResult {
  outcome: PushOutcome;
  sent?: number;
  duplicates?: number;
  because?: string;
}

function cursorPathFor(home: string): string {
  return join(home, MEMNOX_HOME, CURSOR_FILE);
}

export async function readCursor(home: string): Promise<Cursor> {
  try {
    return JSON.parse(await readFile(cursorPathFor(home), 'utf8')) as Cursor;
  } catch {
    return {}; // Nothing sent yet, which is where every machine starts.
  }
}

async function writeCursor(home: string, cursor: Cursor): Promise<void> {
  const path = cursorPathFor(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(cursor, null, 2)}\n`, {
    encoding: 'utf8',
    mode: OWNER_ONLY,
  });
}

/**
 * Ed25519 over the exact bytes posted.
 *
 * The control plane verifies the raw body, so the string signed here is the
 * string sent — serialising twice would produce two different bodies and a
 * signature that never verifies.
 */
export function signBody(privateKey: string, body: string): string {
  void createSign; // Ed25519 signs in one call; no hash is chosen here.
  return signBytes(null, Buffer.from(body, 'utf8'), privateKey).toString('base64');
}

/**
 * The wire shape the ingest door reads. A digest, never the arguments.
 *
 * One action, one event. The control plane's activity projection reads this
 * kind and writes what was attempted, what was decided and what happened from
 * it — the three tables a timeline is built from. Naming the surface instead,
 * as this once did, landed every row in the log and projected none of them:
 * the events were stored and nothing that reads them ever saw one.
 *
 * The payload's field names are the projection's, not this schema's. That is
 * the seam, and it is spelled out here rather than left to match by luck.
 */
export function draftFrom(event: MemnoxEvent): Record<string, unknown> {
  const ranFor = event.durationMs;
  return {
    kind: ACTION_RECORDED,
    // Stable across a resend, which is what lets the control plane deduplicate.
    dedupKey: event.id,
    // The action's own id: `decisions` and `results` are keyed on it.
    subjectId: event.id,
    actorType: event.actorType,
    occurredAt: Date.parse(event.at),
    agentSessionId: event.sessionId,
    payload: {
      surface: event.surface,
      operation: event.operation,
      classes: [event.class],
      effect: event.effect,
      finalEffect: event.effect,
      reason: event.reason,
      ...(event.target === undefined ? {} : { resourceRef: event.target }),
      ...(event.argsDigest === undefined ? {} : { argsDigest: event.argsDigest }),
      ...(event.rule === undefined ? {} : { ruleId: event.rule.name }),
      ...(event.policyHash === undefined ? {} : { policyHash: event.policyHash }),
      ...(event.alternative === undefined
        ? {}
        : { alternative: event.alternative.action }),
      ...(event.exitCode === undefined
        ? {}
        : { exitCode: event.exitCode, errored: event.exitCode !== 0 }),
      ...(ranFor === undefined ? {} : { startedAt: Date.parse(event.at) - ranFor }),
    },
  };
}

/** The control plane's name for a whole action reported after the fact. */
const ACTION_RECORDED = 'agent.action.recorded';

interface PushSeams {
  now?: () => Date;
}

export async function pushEvents(
  home: string,
  account: Account,
  ledger: EventSink,
  seams: PushSeams = {},
): Promise<PushResult> {
  const now = seams.now ?? (() => new Date());
  const cursor = await readCursor(home);
  const since =
    cursor.pushedThrough === undefined
      ? undefined
      : new Date(Date.parse(cursor.pushedThrough) - OVERLAP_MS).toISOString();

  const events = await ledger.query({
    ...(since === undefined ? {} : { since }),
    limit: BATCH,
  });
  if (events.length === 0) return { outcome: PUSH_OUTCOME.NOTHING };

  const body = JSON.stringify({ events: events.map(draftFrom) });
  const answer = await callCloud<{ accepted: number; duplicates: number }>({
    baseUrl: account.baseUrl,
    path: `/v1/workspaces/${account.workspaceId}/events`,
    method: 'POST',
    token: account.token,
    body: JSON.parse(body) as unknown,
    signature: signBody(account.privateKey, body),
    machineId: account.machineId,
    rawBody: body,
  });

  if (answer.status === 401 || answer.status === 403) {
    return { outcome: PUSH_OUTCOME.REVOKED };
  }
  if (answer.status !== 202) {
    return {
      outcome: PUSH_OUTCOME.REFUSED,
      because: `the control plane answered ${answer.status}`,
    };
  }

  const newest = events[events.length - 1];
  await writeCursor(home, {
    ...(newest === undefined ? {} : { pushedThrough: newest.at }),
    lastPushAt: now().toISOString(),
  });
  return {
    outcome: PUSH_OUTCOME.SENT,
    sent: answer.body?.accepted ?? events.length,
    duplicates: answer.body?.duplicates ?? 0,
  };
}
