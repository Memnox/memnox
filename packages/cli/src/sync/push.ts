import { createSign, sign as signBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  DECISION_EFFECT,
  EXECUTION,
  MEMNOX_HOME,
  type EventSink,
  type MemnoxEvent,
} from '@memnox/core';
import type { EnvironmentSnapshot } from '@memnox/core';
import type { Account } from '@memnox/core';
import { censusFrom } from './census';
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
const MAX_POST = 500;

/**
 * How many actions one pass reads.
 *
 * The same as the post limit, because one action is not one row on the wire: it
 * also declares the session it belongs to and, when it was held, the approval that
 * was asked for and how it ended. `fitting` is what keeps a batch inside the limit;
 * this only bounds the read.
 */
const BATCH = MAX_POST;

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
  /** `takenAt` of the newest scan already sent, so one scan is sent once. */
  censusThrough?: string;
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

async function mergeCursor(home: string, patch: Cursor): Promise<void> {
  await writeCursor(home, { ...(await readCursor(home)), ...patch });
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
      /* Both projections key their rows on this and neither falls back to
         anything: without it `project-capabilities` returns before its first
         insert, so a console built to answer what each agent can do had no
         agents in it at all. */
      agentId: event.agent,
      surface: event.surface,
      operation: event.operation,
      classes: [event.class],
      effect: event.effect,
      finalEffect: finalEffectOf(event),
      reason: event.reason,
      ...(event.target === undefined ? {} : { resourceRef: event.target }),
      ...(event.argsDigest === undefined ? {} : { argsDigest: event.argsDigest }),
      ...(event.rule === undefined ? {} : { ruleId: event.rule.name }),
      ...(event.policyHash === undefined ? {} : { policyHash: event.policyHash }),
      /* Which rules and which freeze this was decided under. Without them a verdict
         in the console cannot be replayed against what was in force at the time,
         which is the difference between a record and a screenshot. */
      ...(event.bundleHash === undefined ? {} : { bundleHash: event.bundleHash }),
      ...(event.conditionsInForce === undefined
        ? {}
        : { conditionIds: [...event.conditionsInForce] }),
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

/** And for a session opening, which is what a run of actions is grouped under. */
const SESSION_STARTED = 'agent.session.started';

/** A held call, and how it ended. Both are derived; the ledger has no second table. */
const APPROVAL_REQUESTED = 'approval.requested';
const APPROVAL_RESOLVED = 'approval.resolved';

/** An ask that nobody answered in time is a refusal, and is reported as one. */
const TIMED_OUT = 'timed-out';

/** The id an action's approval is filed under, on both sides and across resends. */
const approvalIdFor = (event: MemnoxEvent): string => `apr_${event.id}`;

/** Whether a held call has an ending yet. An unanswered one stays open, correctly. */
function endingOf(event: MemnoxEvent): { outcome: string; by?: string } | null {
  if (event.authorizedBy !== undefined) {
    return { outcome: 'approved', by: event.authorizedBy };
  }
  if (event.execution === EXECUTION.TIMED_OUT) return { outcome: TIMED_OUT };
  // Held, and stopped: somebody said no, or nothing answered and the hold expired.
  if (event.execution === EXECUTION.BLOCKED) return { outcome: 'denied' };
  return null;
}

/**
 * What the boundary finally did, as against what it first said.
 *
 * An `ask` that somebody released ran, and reporting it as `ask` for ever would
 * leave every action a person actually approved sitting in the console as though
 * it were still waiting on them — the one row where the difference is the point.
 */
function finalEffectOf(event: MemnoxEvent): string {
  if (event.effect !== DECISION_EFFECT.ASK) return event.effect;
  const ending = endingOf(event);
  if (ending === null) return event.effect;
  return ending.outcome === 'approved' ? DECISION_EFFECT.ALLOW : DECISION_EFFECT.DENY;
}

/**
 * The approval rows an action implies.
 *
 * A held call is recorded on the action itself here — `effect` says it was asked
 * about and `authorizedBy` says who released it — so there is no approval table to
 * read and these are derived from the one row. The control plane has both, and its
 * inbox is built from them, so an approval that was never sent is a queue that
 * always looks empty however many times somebody was actually interrupted.
 */
function approvalsFrom(event: MemnoxEvent): Record<string, unknown>[] {
  if (event.effect !== DECISION_EFFECT.ASK) return [];
  const id = approvalIdFor(event);
  const asked = {
    kind: APPROVAL_REQUESTED,
    dedupKey: id,
    subjectId: id,
    actorType: event.actorType,
    occurredAt: Date.parse(event.at),
    agentSessionId: event.sessionId,
    payload: {
      actionId: event.id,
      /* The terminal, because that is where this machine holds one. Naming a
         channel it does not have would put a route on screen nobody can use. */
      channel: 'terminal',
      ...(event.rule === undefined ? {} : { scope: event.rule.name }),
    },
  };

  const ending = endingOf(event);
  if (ending === null) return [asked];
  return [
    asked,
    {
      kind: APPROVAL_RESOLVED,
      dedupKey: `${id}:resolved`,
      subjectId: id,
      actorType: event.actorType,
      occurredAt: Date.parse(event.at),
      agentSessionId: event.sessionId,
      payload: {
        outcome: ending.outcome,
        ...(ending.by === undefined ? {} : { resolvedBy: ending.by }),
      },
    },
  ];
}

/**
 * One row per session the batch mentions.
 *
 * The ledger has no session table — a session is the id its events carry — so
 * this derives the opening from the earliest event of each. Without it the
 * control plane held actions filed under a session it had no record of, and its
 * census knew the agent only by whatever an action happened to name.
 *
 * The key is the session rather than the moment, so a later batch for the same
 * session deduplicates against the first rather than reopening it.
 */
function sessionsFrom(events: readonly MemnoxEvent[]): Record<string, unknown>[] {
  const opening = new Map<string, MemnoxEvent>();
  for (const event of events) {
    const held = opening.get(event.sessionId);
    if (held === undefined || event.at < held.at) opening.set(event.sessionId, event);
  }
  return [...opening.values()].map((event) => ({
    kind: SESSION_STARTED,
    dedupKey: `session:${event.sessionId}`,
    subjectId: event.sessionId,
    actorType: event.actorType,
    occurredAt: Date.parse(event.at),
    agentSessionId: event.sessionId,
    payload: { agentId: event.agent, agentKind: event.agent },
  }));
}

interface PushSeams {
  now?: () => Date;
}

/**
 * As many actions as fit, and every row each one implies.
 *
 * One action is not one row on the wire: it also opens its session and, when it was
 * held, asks for and resolves an approval. Counting actions against the post limit
 * would send up to four times it and have the whole batch refused, and the cursor
 * only advances past what was actually included, so the rest goes next pass rather
 * than being skipped.
 */
export function fitting(events: readonly MemnoxEvent[]): {
  drafts: Record<string, unknown>[];
  through: MemnoxEvent[];
} {
  const sessions = new Set<string>();
  const through: MemnoxEvent[] = [];
  let rows = 0;

  for (const event of events) {
    const cost =
      1 + (sessions.has(event.sessionId) ? 0 : 1) + approvalsFrom(event).length;
    if (rows + cost > MAX_POST) break;
    rows += cost;
    sessions.add(event.sessionId);
    through.push(event);
  }

  /* Sessions first: a verdict filed under a session the log has not opened yet is
     a row citing something that does not exist. Approvals after the action they
     name, for the same reason. */
  return {
    drafts: [
      ...sessionsFrom(through),
      ...through.flatMap((event) => [draftFrom(event), ...approvalsFrom(event)]),
    ],
    through,
  };
}

/**
 * Send a kept scan, once.
 *
 * Its own post rather than riding with the actions: a census is hundreds of rows
 * on a machine with a few agents, and one that could not fit alongside a busy
 * afternoon's work would simply never be sent. Chunked for the same reason, and
 * the cursor only moves when every chunk landed, so a half-sent census is resent
 * whole rather than leaving the console with a partial estate.
 */
export async function pushCensus(
  home: string,
  account: Account,
  snapshot: EnvironmentSnapshot | null,
): Promise<PushResult> {
  if (snapshot === null) return { outcome: PUSH_OUTCOME.NOTHING };
  const cursor = await readCursor(home);
  if (cursor.censusThrough !== undefined && cursor.censusThrough >= snapshot.takenAt) {
    return { outcome: PUSH_OUTCOME.NOTHING };
  }

  const rows = censusFrom(snapshot);
  if (rows.length === 0) return { outcome: PUSH_OUTCOME.NOTHING };

  for (let at = 0; at < rows.length; at += MAX_POST) {
    const result = await postBatch(account, rows.slice(at, at + MAX_POST));
    if (result.outcome !== PUSH_OUTCOME.SENT) return result;
  }

  await mergeCursor(home, { censusThrough: snapshot.takenAt });
  return { outcome: PUSH_OUTCOME.SENT, sent: rows.length, duplicates: 0 };
}

/** One signed post, and what its status means. Shared by both things that send. */
async function postBatch(
  account: Account,
  drafts: readonly Record<string, unknown>[],
): Promise<PushResult> {
  const body = JSON.stringify({ events: drafts });
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
  return {
    outcome: PUSH_OUTCOME.SENT,
    sent: answer.body?.accepted ?? drafts.length,
    duplicates: answer.body?.duplicates ?? 0,
  };
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

  const { drafts, through } = fitting(events);
  const result = await postBatch(account, drafts);
  if (result.outcome !== PUSH_OUTCOME.SENT) return result;

  /* Only past what was actually included. `fitting` stops short when an action's
     session and approval rows would overflow the post, and a cursor that moved to
     the end of what was read would skip the rest for good. */
  const newest = through[through.length - 1];
  await mergeCursor(home, {
    ...(newest === undefined ? {} : { pushedThrough: newest.at }),
    lastPushAt: now().toISOString(),
  });
  return result;
}
