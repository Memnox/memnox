/**
 * `memnox watch`: keep the inventory current, and report what arrives. A new server, a
 * fresh credential, a skill an agent wrote for itself: changes no config records as one.
 */

import { homedir } from 'node:os';
import type { Command } from 'commander';
import {
  bulkArrivals,
  CHANGE_DIRECTION,
  CHANGE_SUBJECT,
  describeSkill,
  describeUpdate,
  watchablePaths,
  type EnvironmentChange,
  type EnvironmentSnapshot,
  type Alert,
  type Arrival,
  type CredentialFinding,
  type SkillFinding,
  type VersionChange,
} from '@memnox/core';

import type { CliContext } from '../cli-context';
import { describeCount } from '../plural';
import { TONE } from '../flow';
import { defaultScanSeams, rulesCovering, type ScanSeams } from '../machine-scan';
import { watchConfigPaths } from '../config-watch';
import {
  baselineOf,
  driftSince,
  isQuiet,
  lookAtMachine,
  type DriftBaseline,
} from '../scan/machine-drift';

const DEFAULT_INTERVAL_SECONDS = 60;
const MILLISECONDS = 1_000;

// A test that actually slept for a minute would not be run, so the wait is injected.
type Waiter = (milliseconds: number) => Promise<unknown>;

/** Returns early when an agent's configuration changes, so the interval is only the backstop. */
interface Between {
  wait: Waiter;
  close: () => void;
}

function defaultWaiter(): Between {
  const watcher = watchConfigPaths(watchablePaths(homedir()));
  return {
    wait: (milliseconds) => watcher.next(milliseconds),
    close: () => watcher.close(),
  };
}

interface WatchDeps {
  buildSeams: (cwd: string) => ScanSeams;
  cwd: () => string;
  waiter: () => Between;
}

/** Each cycle rescans, reports what arrived, and keeps the new scan as the next baseline. */
export function registerWatchCommand(
  program: Command,
  context: CliContext,
  overrides: Partial<WatchDeps> = {},
): void {
  const deps: WatchDeps = {
    buildSeams: defaultScanSeams,
    cwd: () => process.cwd(),
    waiter: defaultWaiter,
    ...overrides,
  };
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
    .action(async (options: WatchOptions) => runWatch(context, deps, options));
}

interface WatchOptions {
  interval: string;
  cycles?: string;
  json?: boolean;
  probe: boolean;
}

/** Scans on an interval, on one rail for the whole watch, and reports what arrived since the cycle before. */
async function runWatch(
  context: CliContext,
  deps: WatchDeps,
  options: WatchOptions,
): Promise<void> {
  if (options.json !== true) context.flow.open('memnox watch');
  const seams = deps.buildSeams(deps.cwd());
  const interval = parseInterval(options.interval);
  const cycles = parseCycles(options.cycles);
  const between = deps.waiter();
  // Credentials and definitions start unseen, so the first cycle only sets their baselines.
  let baseline: DriftBaseline = {
    snapshot: await seams.snapshots.latest(),
    credentials: null,
    definitions: null,
  };
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    if (cycle > 0) await between.wait(interval * MILLISECONDS);
    baseline = await runCycle(context, seams, baseline, options);
  }
  between.close();
  context.flow.close(
    `Watched ${Number.isFinite(cycles) ? `${cycles} cycle(s)` : 'until stopped'}.`,
  );
}

function parseInterval(raw: string): number {
  const interval = Number(raw);
  if (!Number.isFinite(interval) || interval <= 0) {
    throw new Error('--interval must be a positive number of seconds');
  }
  return interval;
}

function parseCycles(raw: string | undefined): number {
  if (raw === undefined) return Infinity;
  const cycles = Number(raw);
  if (!Number.isFinite(cycles)) throw new Error('--cycles must be a number');
  return cycles;
}

/** Reports what arrived since the baseline, and returns this cycle as the next baseline. */
async function runCycle(
  context: CliContext,
  seams: ScanSeams,
  baseline: DriftBaseline,
  options: WatchOptions,
): Promise<DriftBaseline> {
  const look = await lookAtMachine(seams, { probe: options.probe });
  const drift = driftSince(baseline, look);
  if (isQuiet(drift)) return baselineOf(look);
  renderLogins(context, drift.logins);
  renderDefinitions(context, drift.arrived, options.json === true);
  await renderChanges(context, seams, {
    snapshot: look.snapshot,
    changes: drift.changes,
    alerts: drift.alerts,
    updates: drift.updates,
    asJson: options.json === true,
  });
  return baselineOf(look);
}

function renderLogins(context: CliContext, logins: readonly CredentialFinding[]): void {
  if (logins.length === 0) return;
  context.flow.list(
    'Logged in',
    logins.map((login) => ({
      tone: TONE.WARN,
      text: `${login.kind} logged in`,
      detail: [login.path, 'memnox protect --for <cli>'],
    })),
  );
}

/** A roster as one line, and anything else as its own. */
function renderDefinitions(
  context: CliContext,
  arrived: readonly SkillFinding[],
  asJson: boolean,
): void {
  if (arrived.length === 0) return;
  if (asJson) {
    context.out.line(JSON.stringify({ definitions: arrived }));
    return;
  }
  const arrivals = bulkArrivals(arrived);
  const grouped = new Set(
    arrivals.flatMap((each) => each.definitions.map((one) => one.id)),
  );
  for (const arrival of arrivals) renderRoster(context, arrival);
  const loose = arrived.filter((one) => !grouped.has(one.id));
  if (loose.length > 0) {
    context.flow.list(
      'Arrived',
      loose.map((one) => ({
        tone: TONE.WARN,
        text: describeSkill(one),
        detail: ['memnox skills'],
      })),
    );
  }
}

function renderRoster(context: CliContext, arrival: Arrival): void {
  context.flow.list('A roster arrived', [
    {
      tone: TONE.WARN,
      text: `${arrival.definitions.length} new ${arrival.agent} definitions in ${arrival.root}`,
      detail: [
        arrival.inheriting > 0
          ? `${arrival.inheriting} declare no tools, so each inherits every tool in the session`
          : undefined,
        'memnox skills',
      ],
    },
  ]);
}

interface CycleChanges {
  snapshot: EnvironmentSnapshot;
  changes: readonly EnvironmentChange[];
  alerts: readonly Alert[];
  updates: readonly VersionChange[];
  asJson: boolean;
}

async function renderChanges(
  context: CliContext,
  seams: ScanSeams,
  { snapshot, changes, alerts, updates, asJson }: CycleChanges,
): Promise<void> {
  if (asJson) {
    context.out.line(JSON.stringify({ at: snapshot.takenAt, changes, alerts, updates }));
    return;
  }

  renderUpdatesAndAlerts(context, updates, alerts);
  const plain: EnvironmentChange[] = [];
  for (const change of changes) {
    if (
      change.subject === CHANGE_SUBJECT.SERVER &&
      change.direction === CHANGE_DIRECTION.WIDENS
    ) {
      await renderServer(context, seams, snapshot, change);
      continue;
    }
    plain.push(change);
  }
  if (plain.length > 0) {
    context.flow.list(
      `Changed at ${snapshot.takenAt}`,
      plain.map((change) => ({
        tone: change.direction === CHANGE_DIRECTION.WIDENS ? TONE.WARN : TONE.DIM,
        text: `${change.name} «${change.subject}»  ${change.detail}`,
      })),
    );
  }
}

function renderUpdatesAndAlerts(
  context: CliContext,
  updates: readonly VersionChange[],
  alerts: readonly Alert[],
): void {
  const { flow } = context;
  if (updates.length > 0) {
    flow.list(
      'Updated itself',
      updates.map((update) => ({ tone: TONE.WARN, text: describeUpdate(update) })),
    );
  }
  // The alert first, then the detail: what to do about it is the line people need.
  if (alerts.length > 0) {
    flow.list(
      'Worth looking at',
      alerts.map((alert) => ({
        tone: TONE.WARN,
        text: alert.headline,
        detail: [alert.next],
      })),
    );
  }
}

/** A new server multiplies what every agent reaches, so it gets the whole block. */
async function renderServer(
  context: CliContext,
  seams: ScanSeams,
  snapshot: EnvironmentSnapshot,
  change: EnvironmentChange,
): Promise<void> {
  const { flow, style } = context;
  const server = snapshot.servers.find((each) => each.name === change.name);
  const tools = server === undefined ? [] : server.tools;
  const coverage = await rulesCovering(
    seams,
    tools.map((tool) => tool.name),
  );

  flow.rows(`New MCP server: ${change.name}`, [
    { label: 'brings', value: change.detail },
    {
      label: 'covered',
      value:
        coverage.covered.length === 0
          ? style.warn('no rule covers any of them')
          : `${coverage.covered.length} of ${tools.length} covered by a rule`,
    },
    // A file that would not load might have covered these, so the count is a floor.
    ...(coverage.unreadable.length === 0
      ? []
      : [
          {
            label: '',
            value: style.warn(
              `${describeCount(coverage.unreadable.length, 'rule file')} would not load, so that is a floor. Run "memnox policy check".`,
            ),
          },
        ]),
    ...(change.grantedBy === undefined
      ? []
      : [{ label: 'added by', value: change.grantedBy }]),
  ]);
}
