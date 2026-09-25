import { createHash, sign as signBytes } from 'node:crypto';

import {
  HTTP,
  isCredentialRefused,
  secondsToMs,
  type Account,
  type EnvironmentSnapshot,
  type EventSink,
  type Finding,
  type SkillFinding,
} from '@memnox/core';

import { readNames } from '../agents/names';
import { readDeclined } from '../agents/declined';
import { fitting } from './action-rows';
import { censusFrom, decisionDigest, type CensusDecisions } from './census';
import { callCloud } from './client';
import { MAX_POST, type CloudEvent } from './cloud-event';
import { findingsFrom } from './findings';
import { mergeCursor, readCursor } from './push-cursor';
import { skillChangesFrom } from './skills';
import { localDecisionEvents, readLocalDecisions } from './local-decisions';
import { protectionEvents, readProtectionChanges } from './protection-changes';

/**
 * Sending what this machine did, in signed batches. Nothing here is on the decision
 * path, so a failure loses a send rather than a verdict.
 */

/** How many actions one pass reads; `fitting` is what keeps the rows inside a post. */
const BATCH = MAX_POST;

/**
 * How far back a resend reaches. Every event carries an id the control plane
 * deduplicates on, so an overlap costs a comparison and closes a crash's gap.
 */
const OVERLAP_MS = secondsToMs(60);

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

interface PushSeams {
  now?: () => Date;
}

interface IngestReply {
  accepted: number;
  duplicates: number;
}

const NOTHING: PushResult = { outcome: PUSH_OUTCOME.NOTHING };

/** Ed25519 over the exact bytes posted, because the control plane verifies the raw body. */
export function signBody(privateKey: string, body: string): string {
  return signBytes(null, Buffer.from(body, 'utf8'), privateKey).toString('base64');
}

/**
 * Send a kept scan, once, in its own chunked post because a census is hundreds of rows.
 * The cursor moves only once every chunk landed, so a half-sent census is resent whole.
 */
export async function pushCensus(
  home: string,
  account: Account,
  snapshot: EnvironmentSnapshot | null,
): Promise<PushResult> {
  if (snapshot === null) return NOTHING;
  const decided: CensusDecisions = {
    names: await readNames(home),
    declined: await readDeclined(home),
  };
  const digest = decisionDigest(decided);
  const cursor = await readCursor(home);
  const alreadySent =
    cursor.censusThrough !== undefined &&
    cursor.censusThrough >= snapshot.takenAt &&
    cursor.censusDecided === digest;
  if (alreadySent) return NOTHING;

  const rows = censusFrom(snapshot, decided);
  if (rows.length === 0) return NOTHING;
  const result = await postChunked(account, rows);
  if (result.outcome !== PUSH_OUTCOME.SENT) return result;
  await mergeCursor(home, { censusThrough: snapshot.takenAt, censusDecided: digest });
  return result;
}

/**
 * Send what a kept scan found, once, with its own cursor. Findings deduplicate on their
 * content, so the cursor saves a post each sync and the key makes a resend harmless.
 */
export async function pushFindings(
  home: string,
  account: Account,
  scan: { findings: readonly Finding[]; takenAt: string } | null,
): Promise<PushResult> {
  if (scan === null) return NOTHING;
  const cursor = await readCursor(home);
  if (cursor.findingsThrough !== undefined && cursor.findingsThrough >= scan.takenAt) {
    return NOTHING;
  }

  const rows = findingsFrom(scan.findings, scan.takenAt);
  if (rows.length > 0) {
    const result = await postChunked(account, rows);
    if (result.outcome !== PUSH_OUTCOME.SENT) return result;
  }
  // A clean scan moves the cursor too, or it is reconsidered on every sync.
  await mergeCursor(home, { findingsThrough: scan.takenAt });
  return rows.length === 0 ? NOTHING : sentWhole(rows);
}

/**
 * Where a pass starts: a minute behind the cursor, and never before this enrolment.
 * The cursor outlives a logout, so without the floor a new workspace was sent what
 * this machine did while it answered to another one, or to none.
 */
export function pushFrom(pushedThrough: string | undefined, enrolledAt: string): string {
  const floor = Date.parse(enrolledAt);
  if (pushedThrough === undefined) return new Date(floor).toISOString();
  const behind = Date.parse(pushedThrough) - OVERLAP_MS;
  return new Date(Math.max(behind, floor)).toISOString();
}

export async function pushEvents(
  home: string,
  account: Account,
  ledger: EventSink,
  seams: PushSeams = {},
): Promise<PushResult> {
  const now = seams.now ?? ((): Date => new Date());
  const cursor = await readCursor(home);
  const since = pushFrom(cursor.pushedThrough, account.enrolledAt);

  const events = await ledger.query({ since, limit: BATCH });
  if (events.length === 0) return NOTHING;

  const { drafts, through } = fitting(events);
  const result = await postBatch(account, drafts);
  if (result.outcome !== PUSH_OUTCOME.SENT) return result;

  // Only past what `fitting` included, or the actions it left out would be skipped for good.
  const newest = through[through.length - 1];
  await mergeCursor(home, {
    ...(newest === undefined ? {} : { pushedThrough: newest.at }),
    lastPushAt: now().toISOString(),
  });
  return result;
}

/**
 * Send the skills an agent wrote for itself when the set changes, cursored on content
 * because a skill widened twice inside one interval is two things to see.
 */
export async function pushSkills(
  home: string,
  account: Account,
  review: { findings: readonly SkillFinding[]; takenAt: string } | null,
): Promise<PushResult> {
  if (review === null) return NOTHING;

  const rows = skillChangesFrom(review.findings, review.takenAt);
  const digest = createHash('sha256')
    .update(rows.map((row) => row.dedupKey).join(' '))
    .digest('hex');
  const cursor = await readCursor(home);
  if (cursor.skillsDigest === digest) return NOTHING;

  if (rows.length > 0) {
    const result = await postChunked(account, rows);
    if (result.outcome !== PUSH_OUTCOME.SENT) return result;
  }
  // Moved with nothing to report too, so an agent that taught itself nothing costs one comparison.
  await mergeCursor(home, { skillsDigest: digest });
  return rows.length === 0 ? NOTHING : sentWhole(rows);
}

/**
 * Offer the rules a person decided here to the team, once each; the control plane turns
 * every one into a proposal a second admin approves, never a rule in force.
 */
export async function pushDecisions(home: string, account: Account): Promise<PushResult> {
  const decisions = await readLocalDecisions(home);
  const digest = createHash('sha256')
    .update(decisions.map((each) => each.ref).join(' '))
    .digest('hex');
  const cursor = await readCursor(home);
  if (decisions.length === 0 || cursor.decisionsDigest === digest) return NOTHING;

  const rows = localDecisionEvents(decisions);
  const result = await postChunked(account, rows);
  if (result.outcome !== PUSH_OUTCOME.SENT) return result;
  await mergeCursor(home, { decisionsDigest: digest });
  return result;
}

/** Every stop and start of protection here, once each, so the team sees a machine go ungoverned. */
export async function pushProtection(
  home: string,
  account: Account,
): Promise<PushResult> {
  const changes = await readProtectionChanges(home);
  const digest = createHash('sha256')
    .update(changes.map((each) => each.id).join(' '))
    .digest('hex');
  const cursor = await readCursor(home);
  if (changes.length === 0 || cursor.protectionDigest === digest) return NOTHING;

  const rows = protectionEvents(changes);
  const result = await postChunked(account, rows);
  if (result.outcome !== PUSH_OUTCOME.SENT) return result;
  await mergeCursor(home, { protectionDigest: digest });
  return result;
}

function sentWhole(rows: readonly CloudEvent[]): PushResult {
  return { outcome: PUSH_OUTCOME.SENT, sent: rows.length, duplicates: 0 };
}

/** Every row in posts of at most `MAX_POST`, stopping at the first that does not land. */
async function postChunked(
  account: Account,
  rows: readonly CloudEvent[],
): Promise<PushResult> {
  for (let at = 0; at < rows.length; at += MAX_POST) {
    const result = await postBatch(account, rows.slice(at, at + MAX_POST));
    if (result.outcome !== PUSH_OUTCOME.SENT) return result;
  }
  return sentWhole(rows);
}

/** One signed post, and what its status means. */
async function postBatch(
  account: Account,
  drafts: readonly CloudEvent[],
): Promise<PushResult> {
  const payload = { events: drafts };
  // Serialised once and sent verbatim, so the bytes signed are the bytes sent.
  const body = JSON.stringify(payload);
  const answer = await callCloud<IngestReply>({
    baseUrl: account.baseUrl,
    path: `/v1/workspaces/${account.workspaceId}/events`,
    method: 'POST',
    token: account.token,
    body: payload,
    signature: signBody(account.privateKey, body),
    machineId: account.machineId,
    rawBody: body,
  });

  if (isCredentialRefused(answer.status)) return { outcome: PUSH_OUTCOME.REVOKED };
  if (answer.status !== HTTP.ACCEPTED) {
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
