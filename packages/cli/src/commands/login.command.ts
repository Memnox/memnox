import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { Flow } from '../flow';
import { forgetAccount, readAccount, writeAccount, accountPathFor } from '@memnox/core';
import { insecureBaseUrl } from '../sync/client';
import {
  accountFrom,
  approvalUrl,
  CloudUnreachable,
  EnrolmentRefused,
  machineKeypair,
  requestCode,
  waitForApproval,
  type WaitSeams,
} from '../sync/enrol';

/** Where a workspace lives unless somebody says otherwise. */
const DEFAULT_BASE_URL = 'https://api.memnox.com';

/**
 * Connecting this machine to a workspace, and the three commands around it.
 *
 * Off by default and off after `logout`: with no account file nothing in this
 * CLI makes a network call at all. That is the promise the front page makes, and
 * this is the command that changes it — so it says so, out loud, before it does.
 */
export function registerLoginCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
  seams: WaitSeams & { open?: (url: string) => void } = {},
): void {
  program
    .command('login')
    .description('Connect this machine to a workspace, so it gets your rules')
    /* No workspace to name: this machine has no credential yet, so a workspace
       it claimed would be one nothing here could check. Whoever approves is
       signed in to exactly one, and that is where it lands. */
    .option('--url <base>', 'the control plane', DEFAULT_BASE_URL)
    .option('--enforce', 'start in enforce rather than observe')
    .option('--no-open', 'print the URL instead of opening a browser')
    .action(async (options: { url: string; enforce?: boolean; open: boolean }) => {
      const { out, style } = context;
      const enrolment = {
        baseUrl: options.url,
        ...(options.enforce === true ? { mode: 'enforce' } : {}),
      };

      /* Checked before a key is generated or anything is printed: refusing at
         the first call would read as a network fault, and somebody would go and
         debug DNS for a URL we were never going to accept. */
      const insecure = insecureBaseUrl(options.url);
      if (insecure !== null) {
        throw new Error(
          `${insecure}. Use https, or a control plane on localhost while you develop against one.`,
        );
      }

      const flow = new Flow(out, style);
      flow.open('memnox login');
      flow.step('Control plane', options.url);

      const keys = machineKeypair();
      flow.step('Machine key generated', 'ed25519, never leaves this machine');

      const offer = await request(enrolment, keys.publicKey);
      const url = approvalUrl(options.url, offer.userCode);
      flow.value('Your code', offer.userCode);
      flow.step('Approve at', url);

      // Nobody is at the keyboard on a CI runner, and waiting for a keypress
      // there would hang the build rather than enrol the machine.
      if (options.open && process.stdin.isTTY === true) {
        await pressEnter();
        (seams.open ?? openBrowser)(url);
      }

      flow.step('Waiting for approval…');
      const collected = await waitForApproval(options.url, offer, seams);

      const account = accountFrom(enrolment, keys, collected, new Date().toISOString());
      await writeAccount(home(), account);

      /* Shown because nobody asked for it: this is the moment the machine stops
         being local-only, so what it is now bound to has to be visible without
         running a second command to find out. */
      flow.box('Enrolled', [
        `${style.dim('machine')}     ${collected.machineId}`,
        `${style.dim('workspace')}   ${collected.workspaceId}`,
        `${style.dim('mode')}        ${collected.mode}`,
        `${style.dim('credential')}  ${accountPathFor(home())}`,
      ]);
      flow.close(style.ok('This machine is enrolled.'));
      flow.hint('It now pulls your workspace rules. Nothing else leaves this machine.');
      flow.hint('Take it back off with "memnox logout".');

      /* The one line a script would read, on stdout and undecorated, while
         everything above it is commentary on stderr. */
      out.line(collected.machineId);
    });

  program
    .command('logout')
    .description('Forget the credential. Rules already pulled stay in force')
    .action(async () => {
      const had = await forgetAccount(home());
      context.out.line(had ? 'Logged out. The credential is gone.' : 'Not logged in.');
      if (!had) return;
      /* Said plainly, because the opposite would be worse: logging out of a
         laptop must not quietly stop governing it. */
      context.out.note(
        'The rules already pulled are still enforced, and are no longer refreshed.',
      );
      context.out.note('Revoke this machine in the console to end the enrolment.');
    });

  program
    .command('whoami')
    .description('Which workspace this machine is enrolled in, if any')
    .option('--json', 'machine-readable output')
    .action(async (options: { json?: boolean }) => {
      const account = await readAccount(home());
      if (account === null) {
        if (options.json === true) {
          context.out.json({ enrolled: false });
          return;
        }
        context.out.line('Not logged in. This machine talks to nothing.');
        context.out.note('Connect it with "memnox login".');
        return;
      }
      if (options.json === true) {
        // Never the token or the key: this output gets pasted into issues.
        context.out.json({
          enrolled: true,
          workspaceId: account.workspaceId,
          machineId: account.machineId,
          baseUrl: account.baseUrl,
          enrolledAt: account.enrolledAt,
        });
        return;
      }
      const { out } = context;
      out.line(`workspace   ${account.workspaceId}`);
      out.line(`machine     ${account.machineId}`);
      out.line(`control     ${account.baseUrl}`);
      out.line(`since       ${account.enrolledAt}`);
    });
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
