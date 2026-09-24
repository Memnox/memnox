import { homedir } from 'node:os';

import type { Command } from 'commander';

import { forgetAccount, readAccount } from '@memnox/core';

import type { CliContext } from '../cli-context';
import { connectMachine, DEFAULT_BASE_URL, type ConnectSeams } from '../sync/connect';

/**
 * `memnox login`, `logout` and `whoami`: connecting this machine to a workspace. With no
 * account file nothing makes a network call, and this is the command that changes that.
 */
export function registerLoginCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
  seams: ConnectSeams = {},
): void {
  program
    .command('login')
    .description('Connect this machine to a workspace, so it gets your rules')
    // No workspace flag: nothing unenrolled can prove one, so it lands where the approver is.
    .option('--url <base>', 'the control plane', DEFAULT_BASE_URL)
    .option('--enforce', 'start in enforce rather than observe')
    // Asked for on a terminal, so the flag is for a script enrolling a fleet.
    .option('--name <name>', 'what your workspace calls this machine')
    .option('--no-open', 'print the code and the URL instead of opening a browser')
    .action(async (options: LoginOptions) => runLogin(context, home, seams, options));

  program
    .command('logout')
    .description('Forget the credential. Rules already pulled stay in force')
    .action(async () => runLogout(context, home));

  program
    .command('whoami')
    .description('Which workspace this machine is enrolled in, if any')
    .option('--json', 'machine-readable output')
    .action(async (options: WhoamiOptions) => runWhoami(context, home, options));
}

interface LoginOptions {
  url: string;
  enforce?: boolean;
  name?: string;
  open: boolean;
}

/** Binds this machine to a workspace and prints its id on stdout, so the rail is commentary. */
async function runLogin(
  context: CliContext,
  home: () => string,
  seams: ConnectSeams,
  options: LoginOptions,
): Promise<void> {
  const { out, style, flow } = context;
  flow.commentary();
  flow.open('memnox login');

  const connected = await connectMachine(context, home(), options, seams);

  flow.close(style.ok('This machine is enrolled.'));
  flow.hint('It now pulls your workspace rules. Nothing else leaves this machine.');
  flow.hint('Put your agents to work with "memnox setup".');
  flow.hint('Take it back off with "memnox logout".');

  out.line(connected.machineId);
}

/** Forgets the credential, and says plainly what stays in force without it. */
async function runLogout(context: CliContext, home: () => string): Promise<void> {
  const { flow } = context;
  flow.open('memnox logout');

  const had = await forgetAccount(home());
  if (!had) {
    flow.close('Not logged in, so there was nothing to forget.');
    return;
  }
  flow.close('Logged out. The credential is gone.');
  // Said plainly, because logging out of a laptop must not quietly stop governing it.
  flow.hint('The rules already pulled are still enforced, and are no longer refreshed.');
  flow.hint('Revoke this machine in the console to end the enrolment.');
}

interface WhoamiOptions {
  json?: boolean;
}

/** Which workspace this machine belongs to, if any. Never the token or the key. */
async function runWhoami(
  context: CliContext,
  home: () => string,
  options: WhoamiOptions,
): Promise<void> {
  const { flow } = context;
  const asJson = options.json === true;
  if (!asJson) flow.open('memnox whoami');

  const account = await readAccount(home());
  if (account === null) {
    if (asJson) {
      context.out.json({ enrolled: false });
      return;
    }
    flow.close('Not logged in. This machine talks to nothing.');
    flow.hint('Connect it with "memnox login".');
    return;
  }
  if (asJson) {
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
  flow.rows('Enrolled', [
    { label: 'workspace', value: account.workspaceId },
    { label: 'machine', value: account.machineId },
    { label: 'control', value: account.baseUrl },
    { label: 'since', value: account.enrolledAt },
  ]);
  flow.close(`This machine belongs to ${account.workspaceId}.`);
}
