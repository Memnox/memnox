import { homedir } from 'node:os';
import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { Flow } from '../flow';
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
    .option('--no-open', 'print the code and the URL instead of opening a browser')
    .action(async (options: { url: string; enforce?: boolean; open: boolean }) => {
      const { out, style } = context;
      const flow = new Flow(out, style);
      flow.open('memnox login');

      const connected = await connectMachine(context, home(), options, flow, seams);

      flow.close(style.ok('This machine is enrolled.'));
      flow.hint('It now pulls your workspace rules. Nothing else leaves this machine.');
      flow.hint('Put your agents to work with "memnox setup".');
      flow.hint('Take it back off with "memnox logout".');

      /* The one line a script would read, on stdout and undecorated, while
         everything above it is commentary on stderr. */
      out.line(connected.machineId);
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
