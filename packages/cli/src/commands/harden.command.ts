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

/**
 * Propose, apply, revert. Every step prints its undo before it runs, and a single
 * command puts the machine back: one over-eager default breaking a build at midnight
 * is the failure this product does not recover from.
 */
export function registerHardenCommand(
  program: Command,
  context: CliContext,
  buildSeams: HardenSeamsFactory = defaultSeams,
): void {
  program
    .command('harden')
    .description('Close what the doctor found, reversibly — proposed by default')
    .option('--apply', 'write the proposed steps')
    .option('--revert', 'undo every step this machine applied')
    .action(async (options: { apply?: boolean; revert?: boolean }) => {
      const { out, style } = context;
      const seams = buildSeams();
      const now = new Date().toISOString();

      if (options.revert === true) {
        const applied = await readState(seams);
        if (applied.length === 0) {
          out.line('Nothing to revert: no harden step has been applied on this machine.');
          return;
        }
        const results = await revertHardening(seams.writer, applied, now);
        await writeState(
          seams,
          results.map((result) => result.step),
        );
        for (const result of results) {
          out.line(
            `  ${result.changed ? style.ok('reverted') : style.dim('skipped ')}  ${result.step.description}`,
          );
        }
        return;
      }

      const discovered = await discover(seams.reader, { now });
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
        // The undo is printed before anything runs, never after.
        out.line(`     ${style.dim(`undo: ${step.revert.command}`)}`);
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
      await writeState(seams, applied);
      for (const result of results) {
        if (result.error !== undefined) {
          out.note(`could not apply ${result.step.id}: ${result.error}`);
          continue;
        }
        out.line(`  ${style.ok('applied')}  ${result.step.description}`);
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
