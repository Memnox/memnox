import type { Command } from 'commander';
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
import { defaultScanSeams, scanMachine, type ScanSeams } from '../machine-scan';

const NAME_WIDTH = 26;

/**
 * Configuration drift as an event rather than a mystery. Compared against the last
 * scan this machine kept, so it needs no account, no network and no baseline anybody
 * had to remember to take: every scan records one.
 */
export function registerDiffCommand(
  program: Command,
  context: CliContext,
  buildSeams: (cwd: string) => ScanSeams = defaultScanSeams,
  cwd: () => string = () => process.cwd(),
): void {
  program
    .command('diff')
    .description('What changed in this environment since the last scan')
    .option('--since <when>', 'compare against the last scan at or before this ISO time')
    .option('--from <when>', 'the earlier side of the comparison, as an ISO time')
    .option('--to <when>', 'the later side of the comparison, as an ISO time')
    .option(
      '--fail-on <gate>',
      `exit non-zero when something widened: ${failOnValues().join(' | ')}`,
    )
    .option(
      '--no-probe',
      'do not start MCP servers to ask what they hold; tools go uncounted',
    )
    .action(
      async (options: {
        since?: string;
        from?: string;
        to?: string;
        failOn?: string;
        json?: boolean;
        probe: boolean;
      }) => {
        if (options.failOn !== undefined && !isFailOn(options.failOn)) {
          throw new Error(
            `--fail-on takes one of: ${failOnValues().join(', ')}. Got "${options.failOn}".`,
          );
        }
        const seams = buildSeams(cwd());
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
            context.out.line(JSON.stringify({ changes: [], baseline: null }, null, 2));
            return;
          }
          // A first run has nothing to compare against, and inventing one would be worse.
          context.out.line(
            'No earlier scan to compare against — this one is the baseline.',
          );
          context.out.line(
            context.style.dim('Run "memnox diff" again after something changes.'),
          );
          return;
        }

        const changes = compareSnapshots(before, snapshot);
        const failing =
          options.failOn === undefined ? [] : changesFailing(changes, options.failOn);

        if (options.json === true) {
          context.out.line(
            JSON.stringify({ baseline: before.takenAt, changes, failing }, null, 2),
          );
        } else {
          render(context, before.takenAt, changes);
        }

        if (failing.length > 0) {
          context.out.note(
            `${failing.length} change(s) matched --fail-on ${options.failOn}:`,
          );
          for (const change of failing) {
            context.out.note(`  ${change.subject} ${change.name} — ${change.detail}`);
          }
          process.exitCode = 1;
        }
      },
    );
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
