/**
 * The account file, and the only thing that turns sync on: with no account file nothing
 * makes a network call. In core because the seams are separate processes that need it.
 */
import { chmod, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { EnforcementMode } from '../constants/enforcement.constants';
import { MEMNOX_HOME } from '../config/config';
import { writeJsonFile } from '../store/json-records';

const ACCOUNT_FILE = 'account.json';

/** Owner-only. Anything that can read this can act as this machine. */
const OWNER_ONLY = 0o600;

const ACCOUNT_VERSION = 1;

export interface Account {
  version: number;
  /** Where the control plane is. Printed on every command that mentions it. */
  baseUrl: string;
  workspaceId: string;
  /** For what the CLI prints. Never trusted for anything. */
  workspaceName?: string;
  machineId: string;
  /** Scoped to this machine: report, fetch rules, beat. Nothing else. */
  token: string;
  /** Ed25519 PEM. Signs the batches this machine sends; never leaves. */
  privateKey: string;
  enrolledAt: string;
  /**
   * The last mode the control plane told this machine, so a change can be told from a
   * repetition rather than every heartbeat reverting a deliberate local edit.
   */
  cloudMode?: EnforcementMode;
}

export function accountPathFor(home: string): string {
  return join(home, MEMNOX_HOME, ACCOUNT_FILE);
}

/** Null when there is no account, which is the ordinary state and not an error. */
export async function readAccount(home: string): Promise<Account | null> {
  let raw: string;
  try {
    raw = await readFile(accountPathFor(home), 'utf8');
  } catch {
    return null; // Not logged in. Every caller treats this as "stay local".
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Account>;
    if (
      typeof parsed.baseUrl !== 'string' ||
      typeof parsed.workspaceId !== 'string' ||
      typeof parsed.machineId !== 'string' ||
      typeof parsed.token !== 'string' ||
      typeof parsed.privateKey !== 'string'
    ) {
      return null;
    }
    // Every required field was checked above; the rest are optional.
    return { ...parsed, version: ACCOUNT_VERSION } as Account;
  } catch {
    // A half-written file is not an account. Logging in again replaces it.
    return null;
  }
}

export async function writeAccount(home: string, account: Account): Promise<void> {
  const path = accountPathFor(home);
  await writeJsonFile(path, account);
  // Set explicitly: an existing file keeps its old mode through a write.
  await chmod(path, OWNER_ONLY);
}

/**
 * Deletes the credential and nothing else: rules already pulled stay in force, because
 * logging out must not quietly stop governing a laptop.
 */
export async function forgetAccount(home: string): Promise<boolean> {
  try {
    await rm(accountPathFor(home));
    return true;
  } catch {
    return false; // Nothing to forget.
  }
}
