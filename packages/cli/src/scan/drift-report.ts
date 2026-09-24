import {
  CHANGE_DIRECTION,
  changesFailing,
  compareSnapshots,
  failOnValues,
  isFailOn,
  summarizeChanges,
  type EnvironmentChange,
  type EnvironmentSnapshot,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { TONE } from '../flow';
import { scanMachine, type ScanSeams } from '../machine-scan';

import { describeCount } from '../plural';

/**
 * Configuration drift as an event rather than a mystery. Part of `scan`, because it is the
 * same scan compared against the last one kept, and needs no account or network.
 */

interface DriftOptions {
  since?: string;
  from?: string;
  to?: string;
  failOn?: string;
  json?: boolean;
  probe: boolean;
}

interface DriftView {
  baselineAt: string;
  changes: readonly EnvironmentChange[];
  failing: readonly EnvironmentChange[];
  failOn: string | undefined;
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

/** Renders what moved, and says whether any of it matched --fail-on so the caller can exit. */
export async function renderDrift(
  context: CliContext,
  seams: ScanSeams,
  options: DriftOptions,
): Promise<boolean> {
  if (options.failOn !== undefined && !isFailOn(options.failOn)) {
    throw new Error(
      `--fail-on takes one of: ${failOnValues().join(', ')}. Got "${options.failOn}".`,
    );
  }
  const before = await seams.snapshots.latest(options.from ?? options.since);
  const snapshot = await laterSnapshot(seams, options);
  if (snapshot === null) {
    throw new Error(`No scan was kept at or before ${options.to ?? 'now'}.`);
  }
  if (before === null) {
    renderNoBaseline(context, options.json === true);
    return false;
  }

  const changes = compareSnapshots(before, snapshot);
  const failing =
    options.failOn === undefined ? [] : changesFailing(changes, options.failOn);
  if (options.json === true) {
    context.out.json({ baseline: before.takenAt, changes, failing });
  } else {
    render(context, {
      baselineAt: before.takenAt,
      changes,
      failing,
      failOn: options.failOn,
    });
  }
  return failing.length > 0;
}

/** An explicit --to compares two kept scans; without it the later side is this machine now. */
async function laterSnapshot(
  seams: ScanSeams,
  options: DriftOptions,
): Promise<EnvironmentSnapshot | null> {
  if (options.to !== undefined) return seams.snapshots.latest(options.to);
  const { snapshot } = await scanMachine(seams, { probe: options.probe });
  return snapshot;
}

function renderNoBaseline(context: CliContext, asJson: boolean): void {
  if (asJson) {
    context.out.json({ changes: [], baseline: null });
    return;
  }
  // A first run has nothing to compare against, and inventing one would be worse.
  context.flow.close('No earlier scan to compare against, so this one is the baseline.');
  context.flow.hint('Run "memnox scan --since yesterday" after something changes.');
}

function render(context: CliContext, view: DriftView): void {
  const { flow } = context;
  if (view.changes.length === 0) {
    flow.close(`Nothing moved since ${view.baselineAt}.`);
    return;
  }

  flow.list(
    `Changes since ${view.baselineAt}`,
    view.changes.map((change) => ({
      tone: change.direction === CHANGE_DIRECTION.WIDENS ? TONE.WARN : TONE.DIM,
      text: `${change.name} «${change.subject}»  ${change.detail}`,
      detail: [change.grantedBy],
    })),
  );
  if (view.failing.length > 0) {
    flow.list(
      `Matched --fail-on ${view.failOn ?? ''}`,
      view.failing.map((change) => ({
        tone: TONE.WARN,
        text: `${change.subject} ${change.name}: ${change.detail}`,
      })),
    );
  }
  flow.close(describeDirection(context, view.changes));
}

function describeDirection(
  context: CliContext,
  changes: readonly EnvironmentChange[],
): string {
  const { widens, narrows } = summarizeChanges(changes);
  if (widens === 0) {
    return `${describeCount(narrows, 'change narrows', 'changes narrow')} authority, and none widens it.`;
  }
  return context.style.warn(
    `${describeCount(widens, 'change widens', 'changes widen')} authority, ` +
      `${describeCount(narrows, 'narrows', 'narrow')} it.`,
  );
}
