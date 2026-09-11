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
import { openBrowser } from './browser';
import { insecureBaseUrl } from './client';
import {
  accountFrom,
  approvalUrl,
  CloudUnreachable,
  EnrolmentRefused,
  machineKeypair,
  pageCarriesCode,
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
  /** False prints the URL and the code rather than opening a browser. */
  open?: boolean;
}

export type ConnectSeams = WaitSeams & {
  /** Answers whether a browser actually opened, because the screen turns on it. */
  open?: (url: string) => Promise<boolean> | boolean;
};

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

  /* Straight to the page, because the link the control plane sends carries the
     code in it: there is nothing for a person to read off one screen and type
     into another, so asking them to press a key first is a step that exists
     only to delay the step after it. */
  const opened = options.open === false ? false : await (seams.open ?? openBrowser)(url);

  if (opened) {
    flow.step('Approving in your browser', url);
  } else {
    flow.step('Approve at', url);
  }

  /* Only where a browser could not be opened, or where the address carries no
     code for the page to read. Printing it beside a page that already has it is
     how somebody ends up typing eight characters nobody asked them for. */
  if (!opened || !pageCarriesCode(offer)) {
    flow.value('Your code', offer.userCode);
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
