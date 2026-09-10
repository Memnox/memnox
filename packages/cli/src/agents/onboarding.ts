import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MEMNOX_HOME } from '@memnox/core';

/**
 * What onboarding an agent did, so it can be undone exactly.
 *
 * Preloop's engine is the part of its flow a person actually feels: it backs up
 * the config, rewrites it, and can put it back. The rewrite is the easy half.
 * The record is what makes `offboard` an undo rather than a second guess at
 * what the file used to say.
 *
 * Written before the config is touched and removed only after it is restored,
 * so a process killed in the middle leaves a record pointing at a backup that
 * exists. The other order leaves a rewritten config nothing remembers.
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
  /** The config file that was changed. */
  configPath: string;
  /** Where its previous contents were kept, verbatim. */
  backupPath: string;
  /** The machine this agent was enrolled as, so offboard can revoke it. */
  machineId: string;
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

/**
 * A backup per onboarding, stamped, rather than one per config.
 *
 * Onboarding twice must not overwrite the only copy of what the file said
 * before Memnox ever touched it. The stamp is what lets a second run be
 * reversible too.
 */
export function backupPathFor(
  home: string,
  agentId: string,
  configPath: string,
  at: string,
): string {
  const stamp = at.replace(/[:.]/g, '').replace(/-/g, '');
  const flat = configPath.replace(/[/\\ ]/g, '_');
  return join(agentsDir(home), BACKUPS_DIR, safe(agentId), `${stamp}-${flat}`);
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
  try {
    const raw = await readFile(recordPathFor(home, agentId), 'utf8');
    return JSON.parse(raw) as OnboardRecord;
  } catch {
    return null;
  }
}

/**
 * Kept rather than deleted, so an offboard is still findable afterwards.
 *
 * A record that vanishes leaves nobody able to answer "was this agent ever
 * onboarded, and what happened to it". Renaming keeps the answer and stops
 * `status` reading it as live.
 */
export async function retireRecord(
  home: string,
  agentId: string,
  at: string,
): Promise<void> {
  const path = recordPathFor(home, agentId);
  const stamp = at.replace(/[:.]/g, '').replace(/-/g, '');
  try {
    await rename(path, `${path}.offboarded-${stamp}`);
  } catch {
    // Never onboarded, or already retired. Both are the state offboard wants.
  }
}

/** Keeps an agent id from reaching out of the directory it belongs in. */
function safe(agentId: string): string {
  return agentId.replace(/[^A-Za-z0-9_.-]/g, '_');
}
