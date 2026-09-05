import { homedir, userInfo } from 'node:os';
import type { Command } from 'commander';
import { describePending, HOLD_ANSWER, PendingApprovals } from '@memnox/core';
import type { CliContext } from '../cli-context';

/**
 * A held call, answered from somewhere other than the terminal it started in. Locally
 * that is a second terminal; with the cloud it is a platform lead in Slack. The agent
 * waiting on the other end cannot tell the difference, which is the point.
 */
export function registerApprovalsCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
  now: () => Date = () => new Date(),
  who: () => string = () => userInfo().username,
): void {
  program
    .command('approvals')
    .description('Calls waiting for a person')
    .option('--json', 'machine-readable output')
    .action(async (options: { json?: boolean }) => {
      const moment = now().toISOString();
      const pending = await new PendingApprovals(home()).list(moment);

      if (options.json === true) {
        context.out.line(JSON.stringify(pending, null, 2));
        return;
      }
      if (pending.length === 0) {
        context.out.line('Nothing is waiting.');
        return;
      }
      for (const each of pending) context.out.line(`  ${describePending(each, moment)}`);
      context.out.line('');
      context.out.line(`  memnox approve <id>   or   memnox deny <id>`);
    });

  for (const [name, answer, said, verb] of [
    ['approve', HOLD_ANSWER.ONCE, 'Approved', 'Release'],
    ['deny', HOLD_ANSWER.DENY, 'Denied', 'Refuse'],
  ] as const) {
    program
      .command(`${name} <id>`)
      .description(`${verb} a call that is waiting for a person`)
      .action(async (id: string) => {
        const approvals = new PendingApprovals(home());
        const outcome = await approvals.answer(id, answer, who(), now().toISOString());

        if (outcome === null) {
          throw new Error(
            `Nothing is waiting under "${id}". It may have timed out. Try "memnox approvals".`,
          );
        }
        if ('alreadyAnswered' in outcome) {
          const already = outcome.alreadyAnswered;
          // Two people reaching for the same approval is ordinary, not an error.
          context.out.line(
            `Already ${already.answer} by ${already.answeredBy ?? 'somebody'} at ${already.answeredAt ?? 'some point'}.`,
          );
          return;
        }
        context.out.line(`${said} ${id}. The call is released on the waiting side.`);
      });
  }
}
