/**
 * `memnox rewind`: the working tree, back to before an agent touched it. It keeps its own
 * milestone first, touches only the working tree, and refuses mid-merge or mid-rebase.
 */

import type { Command } from 'commander';
import {
  describeMilestone,
  EXIT,
  MILESTONE_KEEP,
  MILESTONE_REASON,
  Milestones,
  milestonesOfSession,
  RewindRefused,
  type Milestone,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { TONE } from '../flow';
import { NodeGit, NodeWorktree } from '../node-git';

interface RewindOptions {
  list?: boolean;
  to?: string;
  take?: boolean;
  note?: string;
  forget?: string | boolean;
  session?: string;
  last?: boolean;
}

interface RewindDeps {
  build: (cwd: string) => Milestones;
  cwd: () => string;
  now: () => string;
}

function milestonesIn(cwd: string): Milestones {
  return new Milestones(new NodeGit(cwd), new NodeWorktree(cwd));
}

/** The command that pays somebody back the first morning an agent leaves a mess. */
export function registerRewindCommand(
  program: Command,
  context: CliContext,
  overrides: Partial<RewindDeps> = {},
): void {
  const deps: RewindDeps = {
    build: milestonesIn,
    cwd: () => process.cwd(),
    now: () => new Date().toISOString(),
    ...overrides,
  };
  program
    .command('rewind')
    .description('Put the working tree back to before an agent touched it')
    .option('--list', 'the milestones there are')
    .option('--to <id>', 'a particular one, rather than the last')
    .option('--session <id>', 'back to before that session first changed anything')
    .option('--last', 'back to before the most recent session first changed anything')
    .option('--take', 'keep the tree as it is now, without restoring anything')
    .option('--note <text>', 'what this milestone is, for the listing')
    .option('--forget [keep]', 'drop all but the newest few')
    .action(async (options: RewindOptions) => runRewind(context, deps, options));
}

/** Puts the working tree back, and keeps what it replaced so the rewind is undoable. */
async function runRewind(
  context: CliContext,
  deps: RewindDeps,
  options: RewindOptions,
): Promise<void> {
  const milestones = deps.build(deps.cwd());
  const moment = deps.now();
  context.flow.open('memnox rewind');
  try {
    await runRequested(context, milestones, options, moment);
  } catch (err) {
    // A refusal is an answer with a reason, not a stack trace.
    if (err instanceof RewindRefused) {
      context.flow.close(context.style.warn(err.message));
      process.exitCode = EXIT.FAILED;
      return;
    }
    throw err;
  }
}

/** The one thing the flags asked for: forget, take, list, or else restore. */
async function runRequested(
  context: CliContext,
  milestones: Milestones,
  options: RewindOptions,
  moment: string,
): Promise<void> {
  if (options.forget !== undefined) return runForget(context, milestones, options.forget);
  if (options.take === true) return runTake(context, milestones, options.note, moment);
  if (options.list === true) return renderMilestones(context, milestones, moment);
  const target = await resolveTarget(milestones, options);
  return runRestore(context, milestones, target, moment);
}

async function runForget(
  context: CliContext,
  milestones: Milestones,
  forget: string | boolean,
): Promise<void> {
  const keep = typeof forget === 'string' ? Number(forget) : MILESTONE_KEEP;
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error('--forget takes a whole number of milestones to keep, at least 1');
  }
  const dropped = await milestones.forget(keep);
  context.flow.close(
    `Forgot ${dropped.length} milestone(s). The newest is never dropped.`,
  );
}

async function runTake(
  context: CliContext,
  milestones: Milestones,
  note: string | undefined,
  moment: string,
): Promise<void> {
  const { flow } = context;
  const taken = await milestones.take({
    at: moment,
    reason: MILESTONE_REASON.MANUAL,
    ...(note === undefined ? {} : { note }),
  });
  flow.rows('Kept', [
    { label: 'milestone', value: taken.id },
    { label: 'files', value: String(taken.files) },
    ...(note === undefined ? [] : [{ label: 'note', value: note }]),
  ]);
  flow.close(`The working tree is kept as ${taken.id}.`);
  flow.hint(`Come back to it with "memnox rewind --to ${taken.id}".`);
}

async function renderMilestones(
  context: CliContext,
  milestones: Milestones,
  moment: string,
): Promise<void> {
  const { flow } = context;
  const found = await milestones.list();
  if (found.length === 0) {
    flow.close('No milestones here yet.');
    flow.hint(
      'One is kept when an agent first writes here, before a destructive command, and when "memnox run" starts one.',
    );
    return;
  }
  flow.list(
    'Milestones',
    found.map((milestone) => ({
      tone: TONE.DIM,
      text: describeMilestone(milestone, moment),
    })),
  );
  flow.close(`${found.length} milestone(s), newest first.`);
  flow.hint(
    'Go back to one with "memnox rewind --to <id>", or to before a session with "--session <id>".',
  );
}

async function runRestore(
  context: CliContext,
  milestones: Milestones,
  target: Milestone,
  moment: string,
): Promise<void> {
  const { flow, style } = context;
  const { restored, kept } = await milestones.restore(target.id, moment);
  flow.rows('Restored', [
    { label: 'back to', value: `${restored.id}, taken ${restored.takenAt}` },
    // Said first, because the first question after a rewind is "and my work?"
    { label: 'your work', value: `kept as ${kept.id}` },
    { label: 'undo this', value: `memnox rewind --to ${kept.id}` },
  ]);
  flow.close(style.ok(`Working tree back to ${restored.id}.`));
  flow.hint('Only files moved. No commit, no branch and no stash was touched.');
}

/** A session's first milestone, or the latest session's when asked for the last. */
async function resolveTarget(
  milestones: Milestones,
  options: RewindOptions,
): Promise<Milestone> {
  if (options.session === undefined && options.last !== true) {
    return resolveMilestone(milestones, options.to);
  }
  const found = await milestones.list();
  const session = options.session ?? lastSessionIn(found);
  const first =
    session === undefined ? undefined : milestonesOfSession(found, session)[0];
  if (first === undefined) {
    throw new Error(
      session === undefined
        ? 'No milestone here belongs to a session yet. One is kept before an agent first writes.'
        : `No milestone here belongs to session ${session}. "memnox rewind --list" shows the ones there are.`,
    );
  }
  return first;
}

/** The session whose milestone is newest, which is the one somebody just watched go wrong. */
function lastSessionIn(found: readonly Milestone[]): string | undefined {
  return found.find((milestone) => milestone.sessionId !== undefined)?.sessionId;
}

/** The named milestone, or the latest when none was named. */
async function resolveMilestone(milestones: Milestones, id?: string): Promise<Milestone> {
  if (id !== undefined) {
    const found = (await milestones.list()).find((milestone) => milestone.id === id);
    if (found === undefined) {
      throw new Error(
        `No milestone ${id}. "memnox rewind --list" shows the ones there are.`,
      );
    }
    return found;
  }
  const latest = await milestones.latest();
  if (latest === null) {
    throw new Error(
      'Nothing to rewind to. A milestone is taken when "memnox run" starts an agent, or now with "memnox rewind --take".',
    );
  }
  return latest;
}
