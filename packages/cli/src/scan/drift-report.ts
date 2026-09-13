import {
  CHANGE_DIRECTION,
  changesFailing,
  compareSnapshots,
  failOnValues,
  isFailOn,
  summarizeChanges,
  type EnvironmentChange,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { TONE } from '../flow';
import { scanMachine, type ScanSeams } from '../machine-scan';

/**
 * Configuration drift as an event rather than a mystery.
 *
 * Part of `scan` rather than a command of its own, because it is the same scan
 * compared against the last one this machine kept: a person who has just seen
 * what can act here asks what changed next, and two commands to answer one
 * question is one of them going unrun.
 *
 * It needs no account, no network and no baseline anybody had to remember to
 * take, because every saved scan records one.
 */

interface DriftOptions {
  since?: string;
  from?: string;
  to?: string;
  failOn?: string;
  json?: boolean;
  probe: boolean;
}

/** True when any flag asked for a comparison rather than for this moment. */
export function wantsDrift(options: DriftOptions): boolean {
  return (
    options.since !== undefined ||
    options.from !== undefined ||
    options.to !== undefined ||
    options.failOn !== undefined
  );
}

export async function renderDrift(
  context: CliContext,
  seams: ScanSeams,
  options: DriftOptions,
): Promise<void> {
  if (options.failOn !== undefined && !isFailOn(options.failOn)) {
    throw new Error(
      `--fail-on takes one of: ${failOnValues().join(', ')}. Got "${options.failOn}".`,
    );
  }
  const before = await seams.snapshots.latest(options.from ?? options.since);
  /* An explicit --to compares two kept scans; without it the later side is this
     machine right now, which is what somebody at a terminal means by "since". */
  const { snapshot } =
    options.to === undefined
      ? await scanMachine(seams, { probe: options.probe })
      : { snapshot: await seams.snapshots.latest(options.to) };

  if (snapshot === null) {
    throw new Error(`No scan was kept at or before ${options.to ?? 'now'}.`);
  }

  if (before === null) {
    if (options.json === true) {
      context.out.json({ changes: [], baseline: null });
      return;
    }
    // A first run has nothing to compare against, and inventing one would be worse.
    context.flow.close(
      'No earlier scan to compare against, so this one is the baseline.',
    );
    context.flow.hint('Run "memnox scan --since yesterday" after something changes.');
    return;
  }

  const changes = compareSnapshots(before, snapshot);
  const failing =
    options.failOn === undefined ? [] : changesFailing(changes, options.failOn);

  if (options.json === true) {
    context.out.json({ baseline: before.takenAt, changes, failing });
  } else {
    render(context, before.takenAt, changes, failing, options.failOn);
  }

  if (failing.length > 0) process.exitCode = 1;
}

function render(
  context: CliContext,
  baselineAt: string,
  changes: readonly EnvironmentChange[],
  failing: readonly EnvironmentChange[],
  failOn: string | undefined,
): void {
  const { flow, style } = context;

  if (changes.length === 0) {
    flow.close(`Nothing moved since ${baselineAt}.`);
    return;
  }

  flow.list(
    `Changes since ${baselineAt}`,
    changes.map((change) => ({
      tone: change.direction === CHANGE_DIRECTION.WIDENS ? TONE.WARN : TONE.DIM,
      text: `${change.name} «${change.subject}»  ${change.detail}`,
      detail: [change.grantedBy],
    })),
  );

  if (failing.length > 0) {
    flow.list(
      `Matched --fail-on ${failOn ?? ''}`,
      failing.map((change) => ({
        tone: TONE.WARN,
        text: `${change.subject} ${change.name}: ${change.detail}`,
      })),
    );
  }

  const { widens, narrows } = summarizeChanges(changes);
  flow.close(
    widens === 0
      ? `${narrows} ${narrows === 1 ? 'change narrows' : 'changes narrow'} authority, and none widens it.`
      : style.warn(
          `${widens} ${widens === 1 ? 'change widens' : 'changes widen'} authority, ` +
            `${narrows} ${narrows === 1 ? 'narrows' : 'narrow'} it.`,
        ),
  );
}
