import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MEMNOX_HOME } from '../config/config';

/**
 * The account file, and the only thing that turns any of this on.
 *
 * It lives here rather than beside the CLI's sync code because the seams are separate
 * processes and need it too: a lease taken on one machine has to be checked against
 * the workspace, and an interceptor cannot import a command.
 *
 * With no account file nothing here makes a network call at all — not a
 * heartbeat, not a lookup, nothing. That is the whole of the promise on the
 * front page, so it is one file and one check rather than a flag somewhere.
 */

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
    return { ...parsed, version: ACCOUNT_VERSION } as Account;
  } catch {
    // A half-written file is not an account. Logging in again replaces it.
    return null;
  }
}

export async function writeAccount(home: string, account: Account): Promise<void> {
  const path = accountPathFor(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(account, null, 2)}\n`, {
    encoding: 'utf8',
    mode: OWNER_ONLY,
  });
  // Set explicitly: an existing file keeps its old mode through a write.
  await chmod(path, OWNER_ONLY);
}

/**
 * Deletes the credential and nothing else.
 *
 * Rules already pulled stay in force, which is deliberate — logging out of a
 * laptop must not quietly stop governing it. Revoking the machine in the console
 * is what ends the enrolment, and `memnox doctor` says when the rules on disk
 * are no longer being refreshed.
 */
export async function forgetAccount(home: string): Promise<boolean> {
  try {
    await rm(accountPathFor(home));
    return true;
  } catch {
    return false; // Nothing to forget.
  }
}
