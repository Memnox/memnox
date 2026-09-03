import type { Command } from 'commander';
import {
  CHANGE_DIRECTION,
  authorityTrend,
  compareSnapshots,
  summarizeChanges,
  type AuthorityTrend,
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
    .option('--trend', 'how far authority has moved across every scan kept here')
    .option('--json', 'emit the changes as JSON')
    .option(
      '--no-probe',
      'do not start MCP servers to ask what they hold; tools go uncounted',
    )
    .action(
      async (options: {
        since?: string;
        trend?: boolean;
        json?: boolean;
        probe: boolean;
      }) => {
        const seams = buildSeams(cwd());
        const before = await seams.snapshots.latest(options.since);
        const { snapshot } = await scanMachine(seams, { probe: options.probe });

        if (options.trend === true) {
          const trend = authorityTrend([...(await seams.snapshots.history())]);
          if (options.json === true) {
            context.out.line(JSON.stringify(trend, null, 2));
            return;
          }
          renderTrend(context, trend);
          return;
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
        if (options.json === true) {
          context.out.line(
            JSON.stringify({ baseline: before.takenAt, changes }, null, 2),
          );
          return;
        }
        render(context, before.takenAt, changes);
      },
    );
}

/**
 * No single change is alarming. A server here, a scope there, and over two quarters
 * the estate is unrecognisable with nothing having recorded the direction of travel.
 */
function renderTrend(context: CliContext, trend: AuthorityTrend): void {
  const { out, style } = context;
  out.line('');
  out.line(style.bold('EXTERNAL WRITE CAPABILITY'));
  out.line('');

  if (trend.points.length < 2) {
    out.line('  One scan kept. There is no direction of travel to report yet.');
    out.line('');
    return;
  }

  for (const point of trend.points) {
    out.line(
      `  ${point.at.slice(0, 10)}  ${'\u2588'.repeat(point.externalWrite)} ${point.externalWrite}`,
    );
  }

  out.line('');
  const direction = trend.added >= 0 ? '+' : '';
  out.line(
    style.bold(
      `  ${direction}${trend.added}` +
        // A percentage off a base of nothing would be a number somebody quotes.
        (trend.percent === undefined ? '' : `  (${direction}${trend.percent}%)`),
    ),
  );

  if (trend.contributors.length > 0) {
    out.line('');
    out.line(style.bold('  LARGEST CONTRIBUTORS'));
    out.line('');
    for (const contributor of trend.contributors) {
      out.line(`    +${contributor.added}   ${contributor.server} «mcp»`);
      out.line(`         ${style.dim(contributor.grantedBy)}`);
    }
  }
  out.line('');
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
