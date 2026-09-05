import { homedir } from 'node:os';
import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { readAccount } from '../sync/account';
import { PULL_OUTCOME, type PullResult } from '../sync/bundle';
import { onePass, type Pass } from '../sync/heartbeat';
import { PUSH_OUTCOME, type PushResult } from '../sync/push';

/**
 * One pass, now: pull the rules, send what happened, say this machine is alive.
 *
 * The daemon runs the same pass on its heartbeat. This command is what a person
 * reaches for when they want it immediately, or want to know why the rules look
 * older than the ones somebody just published.
 */
export function registerSyncCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
): void {
  const sync = program
    .command('sync')
    .description('Pull the rules this workspace publishes, and send what happened');

  sync
    .command('now', { isDefault: true })
    .description('Do a pass now rather than waiting for the next heartbeat')
    .option('--json', 'machine-readable output')
    .action(async (options: { json?: boolean }) => {
      if ((await readAccount(home())) === null) {
        context.out.line('Not logged in, so there is nothing to sync.');
        context.out.note('Connect this machine with "memnox login".');
        return;
      }

      const pass = await onePass(home());
      if (options.json === true) {
        context.out.json(pass);
        return;
      }
      report(context, pass);
    });
}

function report(context: CliContext, pass: Pass): void {
  if (pass.unreachable === true) {
    /* Not an error to report as one: a machine that cannot reach its control
       plane carries on enforcing what it last agreed to. */
    context.out.line('Could not reach the control plane. The rules on disk still apply.');
    return;
  }
  if (pass.pull !== undefined) reportPull(context, pass.pull);
  if (pass.push !== undefined) reportPush(context, pass.push);
}

function reportPull(context: CliContext, result: PullResult): void {
  const { out, style } = context;
  switch (result.outcome) {
    case PULL_OUTCOME.UNCHANGED:
      out.line('Rules already up to date.');
      return;
    case PULL_OUTCOME.APPLIED:
      out.line(
        `${style.ok('Pulled')} ${result.rules} rule(s) and ${result.conditions} condition(s).`,
      );
      out.note(`bundle ${result.hash}`);
      return;
    case PULL_OUTCOME.REFUSED:
      out.line(
        style.warn('That bundle would not load, so the previous one still applies.'),
      );
      out.note(result.because ?? 'no reason given');
      return;
    case PULL_OUTCOME.REVOKED:
      out.line(style.warn('This machine has been revoked.'));
      out.note(
        'The rules it already pulled still apply. Run "memnox login" to enrol again.',
      );
      return;
    case PULL_OUTCOME.LAPSED:
      out.line(
        style.warn('The subscription has lapsed, so the rules are frozen as they are.'),
      );
      out.note(
        'Nothing has been loosened; this machine enforces what it last agreed to.',
      );
      return;
  }
}

function reportPush(context: CliContext, result: PushResult): void {
  const { out, style } = context;
  switch (result.outcome) {
    case PUSH_OUTCOME.NOTHING:
      out.line('Nothing new to send.');
      return;
    case PUSH_OUTCOME.SENT:
      out.line(
        `Sent ${result.sent} action(s)${
          result.duplicates === 0 ? '' : `, ${result.duplicates} already known`
        }.`,
      );
      return;
    case PUSH_OUTCOME.REVOKED:
      out.line(style.warn('This machine has been revoked, so nothing was sent.'));
      return;
    case PUSH_OUTCOME.REFUSED:
      out.line(style.warn('The control plane would not take that batch.'));
      out.note(`${result.because ?? 'no reason given'} — it stays on this machine.`);
      return;
  }
}
