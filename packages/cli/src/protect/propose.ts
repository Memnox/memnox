import {
  applyHardening,
  chainsFor,
  discover,
  lastProbed,
  planHardening,
  runDoctor,
  withToolsFrom,
  type HardenResult,
  type HardenStep,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { TONE, type FlowItem } from '../flow';
import { readState, registerApplied, writeState, type HardenSeams } from './harden-state';

/**
 * What `protect` does when no flag picked something narrower: find what the doctor
 * finds, and propose the fixes or write them. Every step prints its undo first.
 */

interface ProposeInput {
  seams: HardenSeams;
  cwd: string;
  now: string;
  /** Write the steps rather than only listing them. */
  apply: boolean;
}

export async function runPropose(
  context: CliContext,
  input: ProposeInput,
): Promise<void> {
  const { seams, cwd, now, apply } = input;
  const steps = await proposedSteps(seams, cwd, now);

  if (steps.length === 0) {
    context.flow.close(
      'Nothing to close: the doctor found nothing with a change behind it.',
    );
    return;
  }
  if (!apply) return renderProposed(context, steps);
  return applyAll(context, seams, steps, now);
}

/** The same ground `doctor` covers, or `protect` writes no rule for what it ranked. */
async function proposedSteps(
  seams: HardenSeams,
  cwd: string,
  now: string,
): Promise<HardenStep[]> {
  const discovered = await discover(seams.reader, { now, projectDirs: [cwd] });
  // Nothing here starts an MCP server, so the tools come from the last scan that did,
  // or every tool-shaped finding is unreachable.
  const probed = lastProbed(await seams.snapshots.history());
  const surfaces = withToolsFrom(discovered.surfaces, probed);
  const { findings } = runDoctor({
    resources: discovered.resources,
    reachability: discovered.reachability,
    surfaces,
    // From the hydrated surfaces rather than the unprobed scan, or this is always empty.
    chains: chainsFor(
      discovered.agents.map((agent) => agent.id),
      surfaces,
    ),
  });
  const remediations = findings.flatMap((finding) =>
    finding.remediation === undefined ? [] : [finding.remediation],
  );
  return planHardening(remediations).steps;
}

/** What would be written, and nothing written. */
function renderProposed(context: CliContext, steps: readonly HardenStep[]): void {
  const { flow } = context;
  flow.list(
    'Proposed',
    steps.map((step, index) => ({
      tone: TONE.PLAIN,
      text: `${index + 1}. ${step.description}`,
      // No id while proposing, because an id copied from here reverts nothing yet.
      detail: ['undo: memnox protect --revert'],
    })),
  );
  flow.close(`${steps.length} step(s) proposed. Nothing was changed.`);
  flow.hint('Run "memnox protect --apply" to write these.');
}

/** Writes the steps, records them, and puts the rules it wrote in force. */
async function applyAll(
  context: CliContext,
  seams: HardenSeams,
  steps: readonly HardenStep[],
  now: string,
): Promise<void> {
  const results = await applyHardening(seams.writer, steps, now);
  const applied = results.filter((result) => result.changed).map((result) => result.step);

  // Appended, never replaced, because a revert cannot undo a step it has no note of.
  const already = await readState(seams);
  await writeState(seams, [...already, ...applied]);
  // A rule nobody loads is not a rule.
  await registerApplied(seams, applied);
  renderApplied(context, results, applied.length);
}

function renderApplied(
  context: CliContext,
  results: readonly HardenResult[],
  applied: number,
): void {
  const { flow, style } = context;
  flow.list('Applied', results.map(itemOf));
  const failed = results.filter((result) => result.error !== undefined).length;
  flow.close(
    failed === 0
      ? style.ok(`${applied} step(s) applied.`)
      : style.warn(`${applied} applied, ${failed} could not be.`),
  );
  flow.hint('Put it all back with "memnox protect --revert".');
}

function itemOf(result: HardenResult): FlowItem {
  if (result.error !== undefined) {
    return {
      tone: TONE.WARN,
      text: `could not apply  ${result.step.description}`,
      detail: [result.error],
    };
  }
  return {
    tone: TONE.OK,
    text: `applied  ${result.step.description}`,
    // Real once applied, and the only id a revert can take.
    detail: [`undo just this: memnox protect --revert ${result.step.id}`],
  };
}
