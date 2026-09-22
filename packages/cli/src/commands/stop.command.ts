/**
 * `memnox stop` and `memnox start`: protection off on purpose and visibly, recorded with
 * who and why, and back on in exactly the mode it left, by a person or by the clock.
 */
import { homedir, userInfo } from 'node:os';
import type { Command } from 'commander';
import { readProtectionStop, stopHasEnded, type ProtectionStop } from '@memnox/core';
import type { CliContext } from '../cli-context';
import { minutesFrom } from '../duration';
import type { FlowRow } from '../flow';
import { endStopWhenDue, startProtection, stopProtection } from '../protect/stop';

interface StopOptions {
  for?: string;
  reason?: string;
}

interface StopDeps {
  home: () => string;
  now: () => Date;
  /** Who is acting, recorded on the row and in the team's report. */
  who: () => string;
}

function depsFrom(overrides: Partial<StopDeps>): StopDeps {
  return {
    home: homedir,
    now: () => new Date(),
    who: () => userInfo().username,
    ...overrides,
  };
}

export function registerStopCommand(
  program: Command,
  context: CliContext,
  overrides: Partial<StopDeps> = {},
): void {
  const deps = depsFrom(overrides);
  program
    .command('stop')
    .description('Turn protection off on this machine, on purpose and on the record')
    .option('--for <duration>', 'come back on by itself after this long, e.g. 30m or 2h')
    .option('--reason <text>', 'why, in the words your team will read')
    .action(async (options: StopOptions) => runStop(context, deps, options));
}

export function registerStartCommand(
  program: Command,
  context: CliContext,
  overrides: Partial<StopDeps> = {},
): void {
  const deps = depsFrom(overrides);
  program
    .command('start')
    .description('Turn protection back on, in the mode it was stopped in')
    .action(async () => runStart(context, deps));
}

async function runStop(
  context: CliContext,
  deps: StopDeps,
  options: StopOptions,
): Promise<void> {
  const { flow, style } = context;
  flow.open('memnox stop');
  const home = deps.home();
  const now = deps.now();
  // Read before anything is written, so a bad duration changes nothing.
  const minutes =
    options.for === undefined ? undefined : minutesFrom(options.for, '--for');
  const held = await readProtectionStop(home);
  if (held !== null && !stopHasEnded(held, now)) {
    flow.rows('Already stopped', stopRows(held));
    flow.close(style.warn('Protection was already stopped.'));
    flow.hint('"memnox start" turns it back on.');
    return;
  }
  const { stop, reported } = await stopProtection(home, {
    by: deps.who(),
    now,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    ...(minutes === undefined ? {} : { minutes }),
  });
  flow.rows('Stopped', stopRows(stop));
  flow.close(style.warn('Memnox is not protecting this machine.'));
  flow.hint('No seam or hook rules on anything, and the daemon puts nothing back.');
  if (reported) flow.hint('Your team sees this stop on the next sync.');
  flow.hint(`"memnox start" turns it back on, in ${stop.mode}.`);
}

async function runStart(context: CliContext, deps: StopDeps): Promise<void> {
  const { flow, style } = context;
  flow.open('memnox start');
  const home = deps.home();
  const now = deps.now();
  // A stop whose time ran out is the clock's to end, so the row says so rather than naming you.
  const resumed = await endStopWhenDue(home, now);
  const act =
    resumed === null ? await startProtection(home, { by: deps.who(), now }) : null;
  if (act === null) {
    flow.close(style.ok('Memnox is already protecting this machine.'));
    if (resumed !== null) flow.hint(`The stop ${resumed.by} set ran out by itself.`);
    return;
  }
  flow.rows('Started', [
    { label: 'mode', value: act.stop.mode },
    { label: 'was stopped', value: `by ${act.stop.by} at ${act.stop.at}` },
  ]);
  flow.close(style.ok(`Memnox is protecting this machine again, in ${act.stop.mode}.`));
  if (act.reported) flow.hint('Your team sees this on the next sync.');
}

function stopRows(stop: ProtectionStop): FlowRow[] {
  return [
    { label: 'by', value: stop.by },
    { label: 'because', value: stop.reason ?? 'no reason given' },
    {
      label: 'back on',
      value: stop.until === undefined ? 'when somebody runs "memnox start"' : stop.until,
    },
    { label: 'mode kept', value: stop.mode },
  ];
}
