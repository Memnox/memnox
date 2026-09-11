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
import { scanMachine, type ScanSeams } from '../machine-scan';

const NAME_WIDTH = 26;

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
    context.out.line('No earlier scan to compare against, so this one is the baseline.');
    context.out.line(
      context.style.dim('Run "memnox scan --since yesterday" after something changes.'),
    );
    return;
  }

  const changes = compareSnapshots(before, snapshot);
  const failing =
    options.failOn === undefined ? [] : changesFailing(changes, options.failOn);

  if (options.json === true) {
    context.out.json({ baseline: before.takenAt, changes, failing });
  } else {
    render(context, before.takenAt, changes);
  }

  if (failing.length > 0) {
    context.out.note(`${failing.length} change(s) matched --fail-on ${options.failOn}:`);
    for (const change of failing) {
      context.out.note(`  ${change.subject} ${change.name}: ${change.detail}`);
    }
    process.exitCode = 1;
  }
}

function render(
  context: CliContext,
  baselineAt: string,
  changes: readonly EnvironmentChange[],
): void {
  const { out, style } = context;
  out.line(style.bold('CHANGES SINCE') + '  ' + style.dim(baselineAt));
  out.line('');

  if (changes.length === 0) {
    out.line('  Nothing moved.');
    return;
  }

  for (const change of changes) {
    const widens = change.direction === CHANGE_DIRECTION.WIDENS;
    const mark = widens ? style.warn('+') : '-';
    // Padded before styling: an escape sequence has width nobody can see but padEnd can.
    const label = `${change.name} «${change.subject}»`.padEnd(NAME_WIDTH);
    out.line(`  ${mark} ${label}  ${change.detail}`);
    if (change.grantedBy !== undefined) {
      out.line(`      ${style.dim(change.grantedBy)}`);
    }
  }

  const { widens, narrows } = summarizeChanges(changes);
  out.line('');
  out.line(
    style.dim(
      `${widens} ${widens === 1 ? 'change widens' : 'changes widen'} authority, ` +
        `${narrows} ${narrows === 1 ? 'narrows' : 'narrow'} it`,
    ),
  );
}
