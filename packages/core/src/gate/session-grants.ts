/**
 * What a person already said yes to in one session, kept on disk because every hook and
 * every shell wrapper is its own process, and a grant held in memory ended with the one
 * that received it.
 */
import { join } from 'node:path';

import { TOOL_CLASS } from '../discovery/classify';
import { MEMNOX_HOME } from '../config/config';
import { readJsonFile, writeJsonFile } from '../store/json-records';

/** Two yeses to the same action in one session, and the third is not asked. */
export const LEARN_AFTER_APPROVALS = 2;

export const GRANTS_DIR = 'grants';

/** Enough of a held call to grant against. */
export interface GrantSubject {
  sessionId: string;
  operation: string;
  /** Identical calls share this: what a grant covers when the action destroys something. */
  fingerprint: string;
  /** What the action does, so a delete is only ever granted exactly. */
  class?: string;
}

export interface SessionGrants {
  /** Whether a person already allowed this for the rest of the session. */
  covers(subject: GrantSubject): Promise<boolean>;
  /** "For this session" was the answer. */
  grant(subject: GrantSubject): Promise<void>;
  /** A yes of any kind. True when it was the one that taught the session to stop asking. */
  approved(subject: GrantSubject): Promise<boolean>;
}

interface GrantRecord {
  /** Actions allowed by name for the rest of the session. */
  operations: string[];
  /** Exact calls allowed, for the ones that destroy something. */
  fingerprints: string[];
  /** How many times a person said yes to each action. */
  approvals: Record<string, number>;
}

function emptyRecord(): GrantRecord {
  return { operations: [], fingerprints: [], approvals: {} };
}

/**
 * A yes to a read or a write covers the action, which is what the question named. A yes to
 * a delete covers that one call, since "delete for this session" is not what anybody meant.
 */
function grantsByName(subject: GrantSubject): boolean {
  return subject.class !== TOOL_CLASS.DESTRUCTIVE;
}

function coveredBy(record: GrantRecord, subject: GrantSubject): boolean {
  if (record.fingerprints.includes(subject.fingerprint)) return true;
  return grantsByName(subject) && record.operations.includes(subject.operation);
}

function withGrant(record: GrantRecord, subject: GrantSubject): GrantRecord {
  if (grantsByName(subject)) {
    const operations = [...new Set([...record.operations, subject.operation])];
    return { ...record, operations };
  }
  const fingerprints = [...new Set([...record.fingerprints, subject.fingerprint])];
  return { ...record, fingerprints };
}

/**
 * Counts the yes, and grants the action once it has had enough of them. A delete is never
 * learned, because two yeses to two deletes are two decisions about two different things.
 */
function withApproval(
  record: GrantRecord,
  subject: GrantSubject,
): { record: GrantRecord; learned: boolean } {
  const count = (record.approvals[subject.operation] ?? 0) + 1;
  const counted = {
    ...record,
    approvals: { ...record.approvals, [subject.operation]: count },
  };
  const learns =
    grantsByName(subject) &&
    count >= LEARN_AFTER_APPROVALS &&
    !coveredBy(record, subject);
  return learns
    ? { record: withGrant(counted, subject), learned: true }
    : { record: counted, learned: false };
}

/**
 * What a yes covers: the action, except for a web request, where it is the action on that
 * host, since a yes to one site is not a yes to the internet.
 */
export function grantKeyFor(action: string, target?: string): string {
  return action.startsWith('http.') ? `${action} ${target ?? ''}` : action;
}

/** In memory, for a test or a process that lives as long as its session. */
export class MemoryGrants implements SessionGrants {
  private readonly records = new Map<string, GrantRecord>();

  async covers(subject: GrantSubject): Promise<boolean> {
    return coveredBy(this.recordOf(subject), subject);
  }

  async grant(subject: GrantSubject): Promise<void> {
    this.records.set(subject.sessionId, withGrant(this.recordOf(subject), subject));
  }

  async approved(subject: GrantSubject): Promise<boolean> {
    const { record, learned } = withApproval(this.recordOf(subject), subject);
    this.records.set(subject.sessionId, record);
    return learned;
  }

  forget(sessionId: string): void {
    this.records.delete(sessionId);
  }

  private recordOf(subject: GrantSubject): GrantRecord {
    return this.records.get(subject.sessionId) ?? emptyRecord();
  }
}

/** One file per session under `~/.memnox/grants`, so the next process reads the same yes. */
export class FileGrants implements SessionGrants {
  constructor(private readonly home: string) {}

  async covers(subject: GrantSubject): Promise<boolean> {
    return coveredBy(await this.read(subject), subject);
  }

  async grant(subject: GrantSubject): Promise<void> {
    await this.write(subject, withGrant(await this.read(subject), subject));
  }

  async approved(subject: GrantSubject): Promise<boolean> {
    const { record, learned } = withApproval(await this.read(subject), subject);
    await this.write(subject, record);
    return learned;
  }

  private pathFor(sessionId: string): string {
    // A session id is ours, but it is still a file name, so nothing in it can climb out.
    return join(
      this.home,
      MEMNOX_HOME,
      GRANTS_DIR,
      `${sessionId.replace(/[^\w.-]/g, '_')}.json`,
    );
  }

  private async read(subject: GrantSubject): Promise<GrantRecord> {
    const record = await readJsonFile<GrantRecord>(this.pathFor(subject.sessionId));
    return record === null ? emptyRecord() : { ...emptyRecord(), ...record };
  }

  private async write(subject: GrantSubject, record: GrantRecord): Promise<void> {
    await writeJsonFile(this.pathFor(subject.sessionId), record);
  }
}
