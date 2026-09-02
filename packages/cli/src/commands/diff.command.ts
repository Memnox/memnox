import type { Command } from 'commander';
import {
  CHANGE_DIRECTION,
  compareSnapshots,
  summarizeChanges,
  type EnvironmentChange,
} from '@memnox/discovery';
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
    .option('--json', 'emit the changes as JSON')
    .option(
      '--no-probe',
      'do not start MCP servers to ask what they hold; tools go uncounted',
    )
    .action(async (options: { since?: string; json?: boolean; probe: boolean }) => {
      const seams = buildSeams(cwd());
      const before = await seams.snapshots.latest(options.since);
      const { snapshot } = await scanMachine(seams, { probe: options.probe });

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
      if (options.json === true) {
        context.out.line(JSON.stringify({ baseline: before.takenAt, changes }, null, 2));
        return;
      }
      render(context, before.takenAt, changes);
    });
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
