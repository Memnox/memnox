import type { Command } from 'commander';
import {
  agentUpdates,
  alertsFor,
  CHANGE_DIRECTION,
  CHANGE_SUBJECT,
  compareSnapshots,
  describeUpdate,
  type EnvironmentChange,
  type EnvironmentSnapshot,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import type { CredentialFinding, DiscoveryReport } from '@memnox/core';
import {
  defaultScanSeams,
  rulesCovering,
  scanMachine,
  type ScanSeams,
} from '../machine-scan';

const DEFAULT_INTERVAL_SECONDS = 60;
const MILLISECONDS = 1_000;

/** The wait, as an argument: a test that actually slept for a minute would not be run. */
type Sleeper = (milliseconds: number) => Promise<void>;

const REAL_SLEEP: Sleeper = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * A forgotten permission stops being invisible risk and becomes something with a date
 * on it. Each cycle rescans, reports what arrived, and keeps the new scan as the next
 * baseline — so stopping and starting the watch never loses a change.
 */
export function registerWatchCommand(
  program: Command,
  context: CliContext,
  buildSeams: (cwd: string) => ScanSeams = defaultScanSeams,
  cwd: () => string = () => process.cwd(),
  sleep: Sleeper = REAL_SLEEP,
): void {
  program
    .command('watch')
    .description('Keep the inventory current and report what arrives')
    .option(
      '--interval <seconds>',
      'seconds between scans',
      String(DEFAULT_INTERVAL_SECONDS),
    )
    .option('--cycles <n>', 'stop after this many scans instead of running until stopped')
    .option('--json', 'emit one JSON object per cycle')
    .option(
      '--no-probe',
      'do not start MCP servers to ask what they hold; tools go uncounted',
    )
    .action(
      async (options: {
        interval: string;
        cycles?: string;
        json?: boolean;
        probe: boolean;
      }) => {
        const seams = buildSeams(cwd());
        const interval = Number(options.interval);
        if (!Number.isFinite(interval) || interval <= 0) {
          throw new Error('--interval must be a positive number of seconds');
        }
        const cycles = options.cycles === undefined ? Infinity : Number(options.cycles);
        if (!Number.isFinite(cycles) && options.cycles !== undefined) {
          throw new Error('--cycles must be a number');
        }

        let baseline = await seams.snapshots.latest();
        let previous: DiscoveryReport | null = null;
        for (let cycle = 0; cycle < cycles; cycle += 1) {
          if (cycle > 0) await sleep(interval * MILLISECONDS);
          const { report: scanned, snapshot } = await scanMachine(seams, {
            probe: options.probe,
          });
          const changes = baseline === null ? [] : compareSnapshots(baseline, snapshot);
          /* A login is a capability arriving, and it leaves no trace in an agent's
             config — so the credential directories are watched in their own right. */
          const logins = baseline === null ? [] : newCredentials(previous, scanned);
          previous = scanned;
          /* An agent that updated itself is reported even when nothing else moved:
             nobody granted the difference, which is what makes it worth saying. */
          const updates = baseline === null ? [] : agentUpdates(baseline, snapshot);
          baseline = snapshot;
          if (changes.length === 0 && updates.length === 0 && logins.length === 0)
            continue;
          for (const login of logins) {
            context.out.line(
              `  ${context.style.warn('!')} ${login.kind} logged in — ${login.path}`,
            );
            context.out.line(`      ${context.style.dim('memnox protect --for <cli>')}`);
          }
          await report(context, seams, snapshot, changes, updates, options.json === true);
        }
      },
    );
}

async function report(
  context: CliContext,
  seams: ScanSeams,
  snapshot: EnvironmentSnapshot,
  changes: readonly EnvironmentChange[],
  updates: ReturnType<typeof agentUpdates>,
  asJson: boolean,
): Promise<void> {
  const alerts = alertsFor(changes);
  if (asJson) {
    context.out.line(JSON.stringify({ at: snapshot.takenAt, changes, alerts, updates }));
    return;
  }

  for (const update of updates) {
    context.out.line(`  ${context.style.warn('!')} ${describeUpdate(update)}`);
  }
  // The alert first, then the detail: what to do about it is the line people need.
  for (const alert of alerts) {
    context.out.line(`  ${context.style.warn('!')} ${alert.headline}`);
    context.out.line(`      ${context.style.dim(alert.next)}`);
  }

  for (const change of changes) {
    if (
      change.subject === CHANGE_SUBJECT.SERVER &&
      change.direction === CHANGE_DIRECTION.WIDENS
    ) {
      await reportServer(context, seams, snapshot, change);
      continue;
    }
    reportPlainly(context, change);
  }
}

/** A new server multiplies what every agent reaches, so it gets the whole block. */
async function reportServer(
  context: CliContext,
  seams: ScanSeams,
  snapshot: EnvironmentSnapshot,
  change: EnvironmentChange,
): Promise<void> {
  const { out, style } = context;
  const server = snapshot.servers.find((each) => each.name === change.name);
  const tools = server === undefined ? [] : server.tools;
  const coverage = await rulesCovering(
    seams,
    tools.map((tool) => tool.name),
  );

  out.line('');
  out.line(style.warn('⚠ NEW MCP SERVER'));
  out.line('');
  out.line(`  ${style.bold(change.name)}`);
  out.line('');
  out.line(`  ${change.detail}`);
  out.line('');
  out.line(
    coverage.covered.length === 0
      ? '  No rule covers any of them.'
      : `  ${coverage.covered.length} of ${tools.length} covered by a rule.`,
  );
  /* A file that would not load might have covered these, so the count above is a floor
     rather than a total. Saying which is the difference between a number and a guess. */
  if (coverage.unreadable.length > 0) {
    const broken = coverage.unreadable.length;
    out.line(
      style.warn(
        `  ${broken} rule file${broken === 1 ? '' : 's'} would not load, so that is a floor.`,
      ),
    );
    out.line(`  ${style.dim('run "memnox policy check" to see which')}`);
  }
  if (change.grantedBy !== undefined) {
    out.line('');
    out.line(`  ${style.dim(`«added by ${change.grantedBy}»`)}`);
  }
  out.line('');
}

function reportPlainly(context: CliContext, change: EnvironmentChange): void {
  const { out, style } = context;
  const widens = change.direction === CHANGE_DIRECTION.WIDENS;
  const mark = widens ? style.warn('+') : '-';
  out.line(`${mark} ${change.name} «${change.subject}»  ${change.detail}`);
}

/** Credentials present now that were not there last cycle. A login is an event. */
function newCredentials(
  before: DiscoveryReport | null,
  after: DiscoveryReport,
): CredentialFinding[] {
  if (before === null) return [];
  const had = new Set(before.credentials.map((each) => each.path));
  return after.credentials.filter((each) => !had.has(each.path));
}
