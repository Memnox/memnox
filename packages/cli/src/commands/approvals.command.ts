import { homedir, userInfo } from 'node:os';
import type { Command } from 'commander';
import {
  describeGroup,
  describePending,
  groupDetail,
  groupPending,
  HOLD_ANSWER,
  PendingApprovals,
} from '@memnox/core';
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
    .option('--flat', 'one row per call instead of one per kind of work')
    .action(async (options: { json?: boolean; flat?: boolean }) => {
      const moment = now().toISOString();
      const pending = await new PendingApprovals(home()).list(moment);

      if (options.json === true) {
        context.out.json(pending);
        return;
      }
      if (pending.length === 0) {
        context.out.line('Nothing is waiting.');
        return;
      }
      if (options.flat === true) {
        for (const each of pending) {
          context.out.line(`  ${describePending(each, moment)}`);
        }
        context.out.line('');
        context.out.line(`  memnox approve <id>   or   memnox deny <id>`);
        return;
      }

      /* Grouped by default. An agent doing real work holds hundreds of calls, and a
         tool that asks about each separately is one people turn off — at which point
         it protects nothing. */
      const groups = groupPending(pending);
      for (const group of groups) {
        const first = group.members[0];
        if (first === undefined) continue;
        context.out.line(`  ${first.id}  ${describeGroup(group)}`);
        // What is actually covered, always shown: a group answered blind is worse than five prompts.
        for (const line of groupDetail(group)) {
          context.out.line(`  ${context.style.dim(line)}`);
        }
      }
      context.out.line('');
      context.out.line(`  memnox approve <id>   or   memnox deny <id>`);
      if (groups.some((group) => group.members.length > 1)) {
        context.out.line(`  add --group to answer for every call of that kind at once`);
      }
    });

  for (const [name, answer, said, verb] of [
    ['approve', HOLD_ANSWER.ONCE, 'Approved', 'Release'],
    ['deny', HOLD_ANSWER.DENY, 'Denied', 'Refuse'],
  ] as const) {
    program
      .command(`${name} <id>`)
      .description(`${verb} a call that is waiting for a person`)
      .option('--group', 'answer for every waiting call of the same kind')
      .action(async (id: string, options: { group?: boolean }) => {
        const approvals = new PendingApprovals(home());
        const moment = now().toISOString();

        if (options.group === true) {
          const answered = await answerGroup(approvals, id, answer, who(), moment);
          if (answered === null) {
            throw new Error(
              `Nothing is waiting under "${id}". It may have timed out. Try "memnox approvals".`,
            );
          }
          context.out.line(`${said} ${answered} call(s) of that kind.`);
          return;
        }

        const outcome = await approvals.answer(id, answer, who(), moment);

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

/**
 * One decision, applied to every call of the same kind that is waiting.
 *
 * The group is recomputed from what is pending right now rather than from a list
 * captured when it was printed: something may have timed out or been answered by
 * somebody else since, and answering those would be answering a question nobody asked.
 */
async function answerGroup(
  approvals: PendingApprovals,
  id: string,
  answer: Parameters<PendingApprovals['answer']>[1],
  by: string,
  at: string,
): Promise<number | null> {
  const pending = await approvals.list(at);
  const group = groupPending(pending).find((each) =>
    each.members.some((member) => member.id === id),
  );
  if (group === undefined) return null;

  let answered = 0;
  for (const member of group.members) {
    const outcome = await approvals.answer(member.id, answer, by, at);
    if (outcome !== null && 'answered' in outcome) answered += 1;
  }
  return answered;
}
