import type { Command } from 'commander';
import {
  describeMilestone,
  MILESTONE_KEEP,
  MILESTONE_REASON,
  Milestones,
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
}

/**
 * The command people keep the tool for. Everything else asks somebody to care about
 * governance before anything has gone wrong; this pays them back the first morning an
 * agent leaves a mess.
 */
export function registerRewindCommand(
  program: Command,
  context: CliContext,
  build: (cwd: string) => Milestones = (cwd) =>
    new Milestones(new NodeGit(cwd), new NodeWorktree(cwd)),
  cwd: () => string = () => process.cwd(),
  now: () => string = () => new Date().toISOString(),
): void {
  program
    .command('rewind')
    .description('Put the working tree back to before an agent touched it')
    .option('--list', 'the milestones there are')
    .option('--to <id>', 'a particular one, rather than the last')
    .option('--take', 'keep the tree as it is now, without restoring anything')
    .option('--note <text>', 'what this milestone is, for the listing')
    .option('--forget [keep]', 'drop all but the newest few')
    .action(async (options: RewindOptions) => {
      const milestones = build(cwd());
      const moment = now();
      context.flow.open('memnox rewind');
      try {
        await act(context, milestones, options, moment);
      } catch (err) {
        // A refusal is an answer with a reason, not a stack trace.
        if (err instanceof RewindRefused) {
          context.flow.close(context.style.warn(err.message));
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });
}

async function act(
  context: CliContext,
  milestones: Milestones,
  options: RewindOptions,
  moment: string,
): Promise<void> {
  const { flow, style } = context;

  if (options.forget !== undefined) {
    const keep =
      typeof options.forget === 'string' ? Number(options.forget) : MILESTONE_KEEP;
    if (!Number.isInteger(keep) || keep < 1) {
      throw new Error('--forget takes a whole number of milestones to keep, at least 1');
    }
    const dropped = await milestones.forget(keep);
    flow.close(`Forgot ${dropped.length} milestone(s). The newest is never dropped.`);
    return;
  }

  if (options.take === true) {
    const taken = await milestones.take({
      at: moment,
      reason: MILESTONE_REASON.MANUAL,
      ...(options.note === undefined ? {} : { note: options.note }),
    });
    flow.rows('Kept', [
      { label: 'milestone', value: taken.id },
      { label: 'files', value: String(taken.files) },
      ...(options.note === undefined ? [] : [{ label: 'note', value: options.note }]),
    ]);
    flow.close(`The working tree is kept as ${taken.id}.`);
    flow.hint(`Come back to it with "memnox rewind --to ${taken.id}".`);
    return;
  }

  if (options.list === true) {
    const found = await milestones.list();
    if (found.length === 0) {
      flow.close('No milestones here yet.');
      flow.hint('One is taken when "memnox run" starts an agent.');
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
    flow.hint('Go back to one with "memnox rewind --to <id>".');
    return;
  }

  const target = await resolve(milestones, options.to);
  const { restored, kept } = await milestones.restore(target.id, moment);

  flow.rows('Restored', [
    { label: 'back to', value: `${restored.id}, taken ${restored.takenAt}` },
    // Said before anything else, because the first question after a rewind is
    // "and my work?"
    { label: 'your work', value: `kept as ${kept.id}` },
    { label: 'undo this', value: `memnox rewind --to ${kept.id}` },
  ]);
  flow.close(style.ok(`Working tree back to ${restored.id}.`));
  flow.hint('Only files moved. No commit, no branch and no stash was touched.');
}

async function resolve(milestones: Milestones, id?: string): Promise<Milestone> {
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
