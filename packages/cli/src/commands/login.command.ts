import { homedir } from 'node:os';
import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { forgetAccount, readAccount } from '@memnox/core';
import { connectMachine, DEFAULT_BASE_URL, type ConnectSeams } from '../sync/connect';

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
  seams: ConnectSeams = {},
): void {
  program
    .command('login')
    .description('Connect this machine to a workspace, so it gets your rules')
    /* No workspace to name: this machine has no credential yet, so a workspace
       it claimed would be one nothing here could check. Whoever approves is
       signed in to exactly one, and that is where it lands. */
    .option('--url <base>', 'the control plane', DEFAULT_BASE_URL)
    .option('--enforce', 'start in enforce rather than observe')
    /* Asked for on a terminal, so the flag is for everything else: a script
       enrolling a fleet names each box rather than leaving the console a
       column of hex ids. */
    .option('--name <name>', 'what your workspace calls this machine')
    .option('--no-open', 'print the code and the URL instead of opening a browser')
    .action(
      async (options: {
        url: string;
        enforce?: boolean;
        name?: string;
        open: boolean;
      }) => {
        const { out, style, flow } = context;
        /* The one line a script reads is the machine id on stdout, so the rail
           is commentary here rather than the answer. */
        flow.commentary();
        flow.open('memnox login');

        const connected = await connectMachine(context, home(), options, seams);

        flow.close(style.ok('This machine is enrolled.'));
        flow.hint('It now pulls your workspace rules. Nothing else leaves this machine.');
        flow.hint('Put your agents to work with "memnox setup".');
        flow.hint('Take it back off with "memnox logout".');

        out.line(connected.machineId);
      },
    );

  program
    .command('logout')
    .description('Forget the credential. Rules already pulled stay in force')
    .action(async () => {
      const { flow } = context;
      flow.open('memnox logout');
      const had = await forgetAccount(home());
      if (!had) {
        flow.close('Not logged in, so there was nothing to forget.');
        return;
      }
      flow.close('Logged out. The credential is gone.');
      /* Said plainly, because the opposite would be worse: logging out of a
         laptop must not quietly stop governing it. */
      flow.hint(
        'The rules already pulled are still enforced, and are no longer refreshed.',
      );
      flow.hint('Revoke this machine in the console to end the enrolment.');
    });

  program
    .command('whoami')
    .description('Which workspace this machine is enrolled in, if any')
    .option('--json', 'machine-readable output')
    .action(async (options: { json?: boolean }) => {
      const { flow } = context;
      if (options.json !== true) flow.open('memnox whoami');
      const account = await readAccount(home());
      if (account === null) {
        if (options.json === true) {
          context.out.json({ enrolled: false });
          return;
        }
        flow.close('Not logged in. This machine talks to nothing.');
        flow.hint('Connect it with "memnox login".');
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
      flow.rows('Enrolled', [
        { label: 'workspace', value: account.workspaceId },
        { label: 'machine', value: account.machineId },
        { label: 'control', value: account.baseUrl },
        { label: 'since', value: account.enrolledAt },
      ]);
      flow.close(`This machine belongs to ${account.workspaceId}.`);
    });
}
