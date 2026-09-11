import { spawn } from 'node:child_process';
import {
  ENFORCEMENT_MODE,
  loadOrCreateConfig,
  saveConfig,
  writeAccount,
  accountPathFor,
  type Account,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { Flow } from '../flow';
import { insecureBaseUrl } from './client';
import {
  accountFrom,
  approvalUrl,
  CloudUnreachable,
  EnrolmentRefused,
  machineKeypair,
  requestCode,
  waitForApproval,
  type WaitSeams,
} from './enrol';

/**
 * Binding this machine to a workspace, once, for whoever needs it done.
 *
 * Extracted because two commands enrol now: `login`, which does only this, and
 * the guided first run, which does it as its first step. Two copies of a device
 * flow is one of them missing the check that refuses `http://`, and it would be
 * the copy somebody added in a hurry.
 */

/** Where a workspace lives unless somebody says otherwise. */
export const DEFAULT_BASE_URL = 'https://api.memnox.com';

interface ConnectOptions {
  url: string;
  enforce?: boolean;
  /** False prints the URL rather than opening a browser, for a machine with none. */
  open?: boolean;
}

export type ConnectSeams = WaitSeams & { open?: (url: string) => void };

interface Connected {
  account: Account;
  machineId: string;
  workspaceId: string;
  mode: string;
}

export async function connectMachine(
  context: CliContext,
  home: string,
  options: ConnectOptions,
  flow: Flow,
  seams: ConnectSeams = {},
): Promise<Connected> {
  const { style } = context;
  const enrolment = {
    baseUrl: options.url,
    ...(options.enforce === true ? { mode: 'enforce' } : {}),
  };

  /* Checked before a key is generated or anything is printed: refusing at the
     first call would read as a network fault, and somebody would go and debug
     DNS for a URL we were never going to accept. */
  const insecure = insecureBaseUrl(options.url);
  if (insecure !== null) {
    throw new Error(
      `${insecure}. Use https, or a control plane on localhost while you develop against one.`,
    );
  }

  flow.step('Control plane', options.url);

  const keys = machineKeypair();
  flow.step('Machine key generated', 'ed25519, never leaves this machine');

  const offer = await request(enrolment, keys.publicKey);
  const url = approvalUrl(options.url, offer.userCode, offer);
  flow.value('Your code', offer.userCode);
  flow.step('Approve at', url);

  // Nobody is at the keyboard on a CI runner, and waiting for a keypress there
  // would hang the build rather than enrol the machine.
  if (options.open !== false && process.stdin.isTTY === true) {
    await pressEnter();
    (seams.open ?? openBrowser)(url);
  }

  flow.step('Waiting for approval…');
  const collected = await waitForApproval(options.url, offer, seams);

  const account = accountFrom(enrolment, keys, collected, new Date().toISOString());
  await writeAccount(home, account);

  /* Only where `--enforce` was passed, which is somebody saying it out loud.
     Enrolling without the flag records what the workspace has this machine set
     to and leaves `config.toml` alone: a login that silently moved a machine out
     of the mode its owner chose would be the worst possible first impression of
     a control plane, and the graduation path exists for exactly this and asks. */
  if (options.enforce === true) {
    const current = await loadOrCreateConfig(home);
    if (current.mode !== ENFORCEMENT_MODE.ENFORCE) {
      await saveConfig(home, { ...current, mode: ENFORCEMENT_MODE.ENFORCE });
    }
  }

  /* Shown because nobody asked for it: this is the moment the machine stops
     being local-only, so what it is now bound to has to be visible without
     running a second command to find out. */
  flow.box('Enrolled', [
    `${style.dim('machine')}     ${collected.machineId}`,
    `${style.dim('workspace')}   ${collected.workspaceId}`,
    `${style.dim('mode')}        ${collected.mode}`,
    `${style.dim('credential')}  ${accountPathFor(home)}`,
  ]);

  return {
    account,
    machineId: collected.machineId,
    workspaceId: collected.workspaceId,
    mode: collected.mode,
  };
}

async function request(
  enrolment: { baseUrl: string; mode?: string },
  publicKey: string,
): ReturnType<typeof requestCode> {
  try {
    return await requestCode(enrolment, publicKey);
  } catch (err) {
    if (err instanceof CloudUnreachable) {
      throw new Error(
        `Could not reach ${enrolment.baseUrl}. This machine is unchanged and still enforcing whatever it already had.`,
      );
    }
    if (err instanceof EnrolmentRefused) throw new Error(err.message);
    throw err;
  }
}

async function pressEnter(): Promise<void> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question('Press ENTER to open it in a browser… ');
  } finally {
    rl.close();
  }
}

/** Best effort, and never fatal: the URL is printed above whatever happens. */
function openBrowser(url: string): void {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // No browser here, which is ordinary on a server. The URL is on screen.
  }
}
