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
import { TONE } from '../flow';

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
      const { flow } = context;
      flow.open('memnox approvals');
      if (pending.length === 0) {
        flow.close('Nothing is waiting.');
        return;
      }
      if (options.flat === true) {
        flow.list(
          'Waiting',
          pending.map((each) => ({
            tone: TONE.WARN,
            text: describePending(each, moment),
          })),
        );
        flow.close(`${pending.length} call(s) waiting.`);
        flow.hint('memnox approve <id>   or   memnox deny <id>');
        return;
      }

      /* Grouped by default. An agent doing real work holds hundreds of calls, and a
         tool that asks about each separately is one people turn off — at which point
         it protects nothing. */
      const groups = groupPending(pending);
      flow.list(
        'Waiting',
        groups.flatMap((group) => {
          const first = group.members[0];
          if (first === undefined) return [];
          return [
            {
              tone: TONE.WARN,
              text: `${first.id}  ${describeGroup(group)}`,
              // What is actually covered, always shown: a group answered blind
              // is worse than five prompts.
              detail: groupDetail(group),
            },
          ];
        }),
      );
      flow.close(
        `${pending.length} call(s) waiting, in ${groups.length} kind(s) of work.`,
      );
      flow.hint('memnox approve <id>   or   memnox deny <id>');
      if (groups.some((group) => group.members.length > 1)) {
        flow.hint('add --group to answer for every call of that kind at once');
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

        const { flow, style } = context;
        flow.open(`memnox ${name}`);

        if (options.group === true) {
          const answered = await answerGroup(approvals, id, answer, who(), moment);
          if (answered === null) {
            throw new Error(
              `Nothing is waiting under "${id}". It may have timed out. Try "memnox approvals".`,
            );
          }
          flow.rows(said, [
            { label: 'kind', value: `every call waiting like ${id}` },
            { label: 'calls', value: String(answered) },
            { label: 'by', value: who() },
          ]);
          flow.close(style.ok(`${said} ${answered} call(s) of that kind.`));
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
          flow.rows('Already answered', [
            { label: 'call', value: id },
            { label: 'answer', value: already.answer ?? 'answered' },
            { label: 'by', value: already.answeredBy ?? 'somebody' },
            { label: 'at', value: already.answeredAt ?? 'some point' },
          ]);
          flow.close('Somebody else got there first, which is ordinary.');
          return;
        }
        flow.rows(said, [
          { label: 'call', value: id },
          { label: 'by', value: who() },
          { label: 'at', value: moment },
        ]);
        flow.close(style.ok(`${said} ${id}. The call is released on the waiting side.`));
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
