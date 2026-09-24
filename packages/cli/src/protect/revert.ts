import { revertHardening, EXIT, HARDEN_TARGET, type HardenStep } from '@memnox/core';
import type { CliContext } from '../cli-context';
import { TONE } from '../flow';
import { readState, writeState, type HardenSeams } from './harden-state';

/**
 * Putting applied steps back, either all of them or the one a person named. The exit
 * code is the caller's to set, and non-zero only for an id that named no applied step.
 */
export async function runRevert(
  context: CliContext,
  seams: HardenSeams,
  wanted: string | true,
  now: string,
): Promise<number> {
  const { flow } = context;
  const recorded = await readState(seams);
  // The state keeps what was reverted too, and those cannot go again.
  const applied = recorded.filter(
    (step) => step.appliedAt !== undefined && step.revertedAt === undefined,
  );
  if (applied.length === 0) {
    flow.close('Nothing to revert: no harden step has been applied on this machine.');
    return EXIT.OK;
  }

  const named = typeof wanted === 'string' ? wanted : null;
  const chosen = named === null ? applied : applied.filter((step) => step.id === named);
  if (named !== null && chosen.length === 0) {
    renderNoSuchStep(context, named, applied);
    // An id nobody applied is a typo, and exiting zero on one hides it.
    return EXIT.FAILED;
  }

  await revertChosen(context, { seams, recorded, chosen, now });
  return EXIT.OK;
}

interface RevertInput {
  seams: HardenSeams;
  recorded: readonly HardenStep[];
  chosen: readonly HardenStep[];
  now: string;
}

async function revertChosen(context: CliContext, input: RevertInput): Promise<void> {
  const { seams, recorded, chosen, now } = input;
  const results = await revertHardening(seams.writer, chosen, now);
  // Everything not chosen stays applied, or a named revert quietly widens to all of them.
  const untouched = recorded.filter(
    (step) => !chosen.some((each) => each.id === step.id),
  );
  await writeState(seams, [...untouched, ...results.map((result) => result.step)]);
  for (const result of results) {
    if (result.step.target !== HARDEN_TARGET.POLICY) continue;
    await seams.forgetPolicy(seams.absolute(result.step.apply.path));
  }

  context.flow.list(
    'Reverted',
    results.map((result) => ({
      tone: result.changed ? TONE.OK : TONE.DIM,
      text: `${result.changed ? 'reverted' : 'skipped '}  ${result.step.description}`,
    })),
  );
  context.flow.close(
    `${results.filter((result) => result.changed).length} step(s) put back.`,
  );
}

/**
 * An id that matched nothing, with what it could have matched, rather than reverting
 * everything and taking away a rule the reader meant to keep.
 */
function renderNoSuchStep(
  context: CliContext,
  named: string,
  applied: readonly HardenStep[],
): void {
  const { flow } = context;
  flow.list(
    `No applied step with id ${named}. These are applied`,
    applied.map((step) => ({ tone: TONE.DIM, text: `${step.id}  ${step.description}` })),
  );
  flow.close(`Nothing was reverted, because ${named} names no applied step.`);
}
