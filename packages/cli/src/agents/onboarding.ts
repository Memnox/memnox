import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { agentNameIn, MEMNOX_HOME, readJsonFile, shortDigest } from '@memnox/core';

import { sameControlPlane } from '../sync/client';

/**
 * What onboarding an agent did, so `offboard` is an exact undo. Written before the config
 * is touched and retired only after it is restored, so a killed process leaves a backup.
 */

const AGENTS_DIR = 'agents';
const BACKUPS_DIR = 'backups';
/** Owner-only: it names a credential's machine and where that machine's config lives. */
const OWNER_ONLY = 0o600;

export interface OnboardRecord {
  /** The agent as the scan knows it: `agt_claude-code`. */
  agentId: string;
  /** The product whose config was rewritten, for what a person reads. */
  product: string;
  /** The product as the scan names it, which the control plane is told. Absent on older records. */
  agentKind?: string;
  /** The config file that was changed. */
  configPath: string;
  /** Where its previous contents were kept, verbatim. */
  backupPath: string;
  /** The machine this agent was enrolled as, so offboard can revoke it. */
  machineId: string;
  /**
   * The workspace the credential was minted in, and where it was asked for. Absent on
   * older records, which are read as belonging to whatever plane is asking.
   */
  workspaceId?: string;
  baseUrl?: string;
  /** The server entry that was added, so offboard removes exactly that one. */
  serverName: string;
  onboardedAt: string;
}

function agentsDir(home: string): string {
  return join(home, MEMNOX_HOME, AGENTS_DIR);
}

function recordPathFor(home: string, agentId: string): string {
  return join(agentsDir(home), `${safe(agentId)}.json`);
}

/** Colons, dots and dashes out of an ISO time, so it can sit inside a file name. */
function stampOf(at: string): string {
  return at.replace(/[:.]/g, '').replace(/-/g, '');
}

interface OnboardBackupInput {
  home: string;
  agentId: string;
  configPath: string;
  at: string;
}

/**
 * A stamped backup per onboarding, named for the file and a digest of its directory,
 * since one agent can keep two configs both called `mcp.json`.
 */
export function onboardBackupPath(input: OnboardBackupInput): string {
  const where = shortDigest(dirname(input.configPath));
  const name = safe(basename(input.configPath));
  return join(
    agentsDir(input.home),
    BACKUPS_DIR,
    safe(input.agentId),
    `${stampOf(input.at)}-${where}-${name}`,
  );
}

export async function writeRecord(home: string, record: OnboardRecord): Promise<void> {
  const path = recordPathFor(home, record.agentId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(record, null, 2), {
    encoding: 'utf8',
    mode: OWNER_ONLY,
  });
}

/** Null where this agent was never onboarded, which is the ordinary case. */
export async function readRecord(
  home: string,
  agentId: string,
): Promise<OnboardRecord | null> {
  return readJsonFile<OnboardRecord>(recordPathFor(home, agentId));
}

/**
 * Every agent this machine has onboarded and not taken back out, skipping unreadable and
 * retired records, because this is read on the sync loop and must never fail it.
 */
export async function listRecords(home: string): Promise<OnboardRecord[]> {
  let names: string[];
  try {
    names = await readdir(agentsDir(home));
  } catch {
    return []; // Nothing has been onboarded here.
  }

  const records: OnboardRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    // One unreadable record reads as null and must not hide the rest.
    const record = await readJsonFile<OnboardRecord>(join(agentsDir(home), name));
    if (typeof record?.agentId === 'string' && typeof record.machineId === 'string') {
      records.push(record);
    }
  }
  return records;
}

/**
 * Whether this record was written against the control plane now in hand, since a
 * credential minted in one workspace is not one in the next. A record naming no plane
 * predates the field and belongs to this one.
 */
export function onboardedInto(
  record: OnboardRecord,
  account: { baseUrl: string; workspaceId: string },
): boolean {
  if (record.workspaceId === undefined) return true;
  return (
    record.workspaceId === account.workspaceId &&
    // The URL too, because two deployments can each hold a workspace called `acme`.
    (record.baseUrl === undefined || sameControlPlane(record.baseUrl, account.baseUrl))
  );
}

/**
 * The product an onboarded agent is, from the record or from its own id, which carries
 * the kind for every record written before the field existed.
 */
export function kindOf(record: OnboardRecord): string {
  return record.agentKind ?? agentNameIn(record.agentId);
}

/** Kept rather than deleted, so whether an agent was ever onboarded stays answerable. */
export async function retireRecord(
  home: string,
  agentId: string,
  at: string,
): Promise<void> {
  const path = recordPathFor(home, agentId);
  try {
    await rename(path, `${path}.offboarded-${stampOf(at)}`);
  } catch {
    // Never onboarded, or already retired. Both are the state offboard wants.
  }
}

/** Keeps an agent id from reaching out of the directory it belongs in. */
function safe(agentId: string): string {
  return agentId.replace(/[^A-Za-z0-9_.-]/g, '_');
}
