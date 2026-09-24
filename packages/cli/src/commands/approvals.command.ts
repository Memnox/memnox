/**
 * A held call, answered from somewhere other than the terminal it started in: a second
 * terminal, or the workspace. The agent waiting cannot tell the difference, which is the point.
 */

import { homedir, userInfo } from 'node:os';
import type { Command } from 'commander';
import {
  describeGroup,
  describePending,
  groupDetail,
  groupPending,
  HOLD_ANSWER,
  PendingApprovals,
  type HoldAnswer,
  type PendingApproval,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { TONE } from '../flow';

/** What listing and answering both need. */
interface ApprovalsDeps {
  context: CliContext;
  home: () => string;
  now: () => Date;
  who: () => string;
}

/** One way to answer, and the word it prints. */
interface HowAnswered {
  name: string;
  answer: HoldAnswer;
  said: string;
}

/** One answer to give, to one call or to every call like it. */
interface AnswerInput {
  approvals: PendingApprovals;
  how: HowAnswered;
  id: string;
  by: string;
  moment: string;
}

/** The two ways to answer a held call, and the words each prints. */
const ANSWERS = [
  { name: 'approve', answer: HOLD_ANSWER.ONCE, said: 'Approved', verb: 'Release' },
  { name: 'deny', answer: HOLD_ANSWER.DENY, said: 'Denied', verb: 'Refuse' },
] as const;

export function registerApprovalsCommand(
  program: Command,
  context: CliContext,
  overrides: Partial<Omit<ApprovalsDeps, 'context'>> = {},
): void {
  const deps: ApprovalsDeps = {
    context,
    home: homedir,
    now: () => new Date(),
    who: () => userInfo().username,
    ...overrides,
  };

  program
    .command('approvals')
    .description('Calls waiting for a person')
    .option('--json', 'machine-readable output')
    .option('--flat', 'one row per call instead of one per kind of work')
    .action(async (options: { json?: boolean; flat?: boolean }) =>
      runApprovals(deps, options),
    );

  for (const { name, answer, said, verb } of ANSWERS) {
    program
      .command(`${name} <id>`)
      .description(`${verb} a call that is waiting for a person`)
      .option('--group', 'answer for every waiting call of the same kind')
      .action(async (id: string, options: { group?: boolean }) =>
        runAnswer(deps, { name, answer, said }, id, options.group === true),
      );
  }
}

/** Everything waiting, grouped by kind of work unless asked for flat. */
async function runApprovals(
  deps: ApprovalsDeps,
  options: { json?: boolean; flat?: boolean },
): Promise<void> {
  const { context, home, now } = deps;
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
  if (options.flat === true) return renderFlat(context, pending, moment);
  return renderGrouped(context, pending);
}

/** One row per call, for somebody who wants to see each one. */
function renderFlat(
  context: CliContext,
  pending: readonly PendingApproval[],
  moment: string,
): void {
  const { flow } = context;
  flow.list(
    'Waiting',
    pending.map((each) => ({ tone: TONE.WARN, text: describePending(each, moment) })),
  );
  flow.close(`${pending.length} call(s) waiting.`);
  flow.hint('memnox approve <id>   or   memnox deny <id>');
}

/** One row per kind of work by default, because asking about each of hundreds gets it turned off. */
function renderGrouped(context: CliContext, pending: readonly PendingApproval[]): void {
  const { flow } = context;
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
          // What is actually covered, always shown: a group answered blind is worse
          // than five prompts.
          detail: groupDetail(group),
        },
      ];
    }),
  );
  flow.close(`${pending.length} call(s) waiting, in ${groups.length} kind(s) of work.`);
  flow.hint('memnox approve <id>   or   memnox deny <id>');
  if (groups.some((group) => group.members.length > 1)) {
    flow.hint('add --group to answer for every call of that kind at once');
  }
}

/** Answers one call, or every waiting call of the same kind. */
async function runAnswer(
  deps: ApprovalsDeps,
  how: HowAnswered,
  id: string,
  group: boolean,
): Promise<void> {
  const { context, home, now, who } = deps;
  const input: AnswerInput = {
    approvals: new PendingApprovals(home()),
    how,
    id,
    by: who(),
    moment: now().toISOString(),
  };

  context.flow.open(`memnox ${how.name}`);
  if (group) return answerEveryLike(context, input);
  return answerOne(context, input);
}

/** One decision covering every call of that kind, with the count it covered. */
async function answerEveryLike(context: CliContext, input: AnswerInput): Promise<void> {
  const { flow, style } = context;
  const { how, id, by } = input;
  const answered = await answerGroup(input);
  if (answered === null) throw nothingWaiting(id);

  flow.rows(how.said, [
    { label: 'kind', value: `every call waiting like ${id}` },
    { label: 'calls', value: String(answered) },
    { label: 'by', value: by },
  ]);
  flow.close(style.ok(`${how.said} ${answered} call(s) of that kind.`));
}

/** One call, or the answer somebody else already gave it. */
async function answerOne(context: CliContext, input: AnswerInput): Promise<void> {
  const { flow, style } = context;
  const { approvals, how, id, by, moment } = input;
  const outcome = await approvals.answer(id, how.answer, by, moment);
  if (outcome === null) throw nothingWaiting(id);

  if ('alreadyAnswered' in outcome) {
    const already = outcome.alreadyAnswered;
    // Two people reaching for the same approval is ordinary rather than an error.
    flow.rows('Already answered', [
      { label: 'call', value: id },
      { label: 'answer', value: already.answer ?? 'answered' },
      { label: 'by', value: already.answeredBy ?? 'somebody' },
      { label: 'at', value: already.answeredAt ?? 'some point' },
    ]);
    flow.close('Somebody else got there first, which is ordinary.');
    return;
  }

  flow.rows(how.said, [
    { label: 'call', value: id },
    { label: 'by', value: by },
    { label: 'at', value: moment },
  ]);
  flow.close(style.ok(`${how.said} ${id}. The call is released on the waiting side.`));
}

/** Said the same way wherever an id matches nothing, because a hold may simply have lapsed. */
function nothingWaiting(id: string): Error {
  return new Error(
    `Nothing is waiting under "${id}". It may have timed out. Try "memnox approvals".`,
  );
}

/**
 * One decision for every waiting call of the same kind, recomputed from what is pending
 * now, since a call may have timed out or been answered since the list was printed.
 */
async function answerGroup(input: AnswerInput): Promise<number | null> {
  const { approvals, how, id, by, moment } = input;
  const pending = await approvals.list(moment);
  const group = groupPending(pending).find((each) =>
    each.members.some((member) => member.id === id),
  );
  if (group === undefined) return null;

  let answered = 0;
  for (const member of group.members) {
    const outcome = await approvals.answer(member.id, how.answer, by, moment);
    if (outcome !== null && 'answered' in outcome) answered += 1;
  }
  return answered;
}
