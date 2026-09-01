import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import {
  applyHardening,
  discover,
  NodeHardenWriter,
  NodeMachineReader,
  planHardening,
  revertHardening,
  runDoctor,
  type HardenStep,
  type HardenWriter,
  type MachineReader,
} from '@memnox/discovery';
import type { CliContext } from '../cli-context';

/** Everything Memnox writes lives here, so nothing lands in a reviewed repository. */
const MEMNOX_HOME = '.memnox';

interface HardenSeams {
  reader: MachineReader;
  writer: HardenWriter;
  /** Where applied steps are recorded, so a later revert knows what to undo. */
  statePath: string;
}

type HardenSeamsFactory = () => HardenSeams;

function defaultSeams(): HardenSeams {
  const root = join(homedir(), MEMNOX_HOME);
  return {
    reader: new NodeMachineReader(homedir()),
    writer: new NodeHardenWriter(root),
    statePath: 'harden-state.json',
  };
}

/** An id nobody applied is a typo, and exiting zero on one hides it. */
const EXIT_NO_SUCH_STEP = 1;

/**
 * Propose, apply, revert. Every step prints its undo before it runs, and a single
 * command puts the machine back: one over-eager default breaking a build at midnight
 * is the failure this product does not recover from.
 */
export function registerHardenCommand(
  program: Command,
  context: CliContext,
  buildSeams: HardenSeamsFactory = defaultSeams,
  cwd: () => string = () => process.cwd(),
): void {
  program
    .command('harden')
    .description('Close what the doctor found, reversibly — proposed by default')
    .option('--apply', 'write the proposed steps')
    .option(
      '--revert [id]',
      'undo one applied step, or every one this machine applied when no id is given',
    )
    .action(async (options: { apply?: boolean; revert?: boolean | string }) => {
      const { out, style } = context;
      const seams = buildSeams();
      const now = new Date().toISOString();

      if (options.revert !== undefined && options.revert !== false) {
        const recorded = await readState(seams);
        // The state keeps what was reverted, so a listing off it offered steps that
        // were already gone as though they could go again.
        const applied = recorded.filter(
          (step) => step.appliedAt !== undefined && step.revertedAt === undefined,
        );
        if (applied.length === 0) {
          out.line('Nothing to revert: no harden step has been applied on this machine.');
          return;
        }

        // An id that reverted everything took away a rule the reader meant to keep,
        // and said nothing about it. Name one and only that one goes.
        const named = typeof options.revert === 'string' ? options.revert : null;
        const chosen = named === null ? applied : applied.filter((s) => s.id === named);
        if (named !== null && chosen.length === 0) {
          out.line(`No applied step with id ${named}.`);
          out.note('');
          for (const step of applied) out.note(`  ${step.id}  ${step.description}`);
          process.exitCode = EXIT_NO_SUCH_STEP;
          return;
        }

        const results = await revertHardening(seams.writer, chosen, now);
        // Everything not chosen stays applied, or a named revert quietly widens.
        const untouched = recorded.filter(
          (step) => !chosen.some((each) => each.id === step.id),
        );
        await writeState(seams, [...untouched, ...results.map((result) => result.step)]);
        for (const result of results) {
          out.line(
            `  ${result.changed ? style.ok('reverted') : style.dim('skipped ')}  ${result.step.description}`,
          );
        }
        return;
      }

      // Same ground as doctor, or harden writes no rule for the credential it ranked.
      const discovered = await discover(seams.reader, { now, projectDirs: [cwd()] });
      const { findings } = runDoctor({
        resources: discovered.resources,
        reachability: discovered.reachability,
        surfaces: discovered.surfaces,
      });
      const proposed = findings.flatMap((finding) =>
        finding.remediation === undefined ? [] : [finding.remediation],
      );
      const plan = planHardening(proposed);

      if (plan.steps.length === 0) {
        out.line('Nothing to close: the doctor found nothing with a change behind it.');
        return;
      }

      out.line(style.bold(options.apply === true ? 'APPLYING' : 'PROPOSED'));
      out.line('');
      plan.steps.forEach((step, index) => {
        out.line(`  ${index + 1}. ${step.description}`);
        /* The undo is printed before anything runs, never after. No id while
           proposing: nothing is applied yet, so an id here names a step that does
           not exist and reverts nothing when a reader copies it. */
        out.line(`     ${style.dim('undo: memnox harden --revert')}`);
      });
      out.line('');

      if (options.apply !== true) {
        out.line(
          `Nothing was changed. Run ${style.bold('memnox harden --apply')} to write these.`,
        );
        return;
      }

      const results = await applyHardening(seams.writer, plan.steps, now);
      const applied = results
        .filter((result) => result.changed)
        .map((result) => result.step);
      // Appended, never replaced: writing only this batch lost the record of an
      // earlier one, and a revert cannot undo a step it has no note of.
      const already = await readState(seams);
      await writeState(seams, [...already, ...applied]);
      for (const result of results) {
        if (result.error !== undefined) {
          out.note(`could not apply ${result.step.id}: ${result.error}`);
          continue;
        }
        out.line(`  ${style.ok('applied')}  ${result.step.description}`);
        // Real once applied, and the only id a revert can take.
        out.line(
          `            ${style.dim(`undo just this: memnox harden --revert ${result.step.id}`)}`,
        );
      }
      out.line('');
      out.line(`Put it all back with ${style.bold('memnox harden --revert')}.`);
    });
}

async function readState(seams: HardenSeams): Promise<HardenStep[]> {
  const raw = await seams.writer.read(seams.statePath);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HardenStep[]) : [];
  } catch {
    // A corrupt state file must not stop a revert of what is still on disk.
    return [];
  }
}

async function writeState(
  seams: HardenSeams,
  steps: readonly HardenStep[],
): Promise<void> {
  await seams.writer.write(seams.statePath, JSON.stringify(steps, null, 2));
}
