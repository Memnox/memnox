/** `memnox daemon`: the long-lived process that holds the rules, and the service that keeps it running. */

import { homedir } from 'node:os';
import type { Command } from 'commander';
import {
  LEDGER_SCAN_LIMIT,
  LocalGate,
  readAccount,
  readBudgets,
  readFleetSpend,
  SessionPauses,
  type Account,
} from '@memnox/core';
import { EGRESS_LOOPBACK } from '@memnox/interceptors';
import { EditWatcher } from '../edit-watcher';
import type { CliContext } from '../cli-context';
import { MemnoxDaemon } from '../daemon-server';
import { withEvents } from '../event-store';
import { policySetInForce } from '../policy-path';
import { BoundaryKeeper } from '../keeper/keep-boundary';
import { DaemonEgress } from '../daemon/egress';
import { syncLoop } from '../sync/heartbeat';
import { installService, serviceState, uninstallService } from '../daemon/service';

/** Optional by design: with no daemon each seam evaluates in its own process and stays governed. */
export function registerDaemonCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
): void {
  program
    .command('daemon')
    .description('Hold the rules in one process, so an interceptor pays a connect')
    .option('-f, --file <path>', 'policy file (default: whichever exists)')
    .option('--no-sync', 'hold the rules but talk to nothing')
    .option('--install', 'have this machine start the daemon and keep it running')
    .option('--uninstall', 'stop starting it, and stop it now')
    .option('--status', 'whether this machine starts it on its own')
    .action(async (options: DaemonOptions) => runDaemon(context, home, options));
}

interface DaemonOptions {
  file?: string;
  sync: boolean;
  install?: boolean;
  uninstall?: boolean;
  status?: boolean;
}

/** Runs the loop, or installs, removes and reports the service that runs it. */
async function runDaemon(
  context: CliContext,
  home: () => string,
  options: DaemonOptions,
): Promise<void> {
  context.flow.open('memnox daemon');
  if (options.status === true) return renderDaemonStatus(context, home());
  if (options.uninstall === true) return renderUninstalled(context, home());
  if (options.install === true) return renderInstalled(context, home());
  return runLoop(context, home, options);
}

/** Whether anything starts this without a person, because a terminal-bound daemon stops with the laptop lid. */
function renderDaemonStatus(context: CliContext, home: string): void {
  const { flow, style } = context;
  const state = serviceState(home);
  if (!state.supported) {
    flow.close('No per-user service manager on this platform.');
    flow.hint('Run "memnox daemon" yourself, or start it however you start things.');
    return;
  }
  flow.rows('Started by the machine', [
    {
      label: 'state',
      value: state.installed
        ? style.ok(`${state.manager} starts it and keeps it running`)
        : style.warn('nothing starts it'),
    },
    { label: 'unit', value: state.path },
  ]);
  flow.close(
    state.installed
      ? 'This machine keeps the daemon running.'
      : 'It runs only while "memnox daemon" is open in a terminal.',
  );
  if (!state.installed) flow.hint('memnox daemon --install   hand it to the machine');
}

async function renderInstalled(context: CliContext, home: string): Promise<void> {
  const { flow } = context;
  const { state, warning } = await installService(home);
  if (!state.supported) {
    flow.close('No per-user service manager on this platform, so nothing was written.');
    return;
  }
  flow.rows('Installed', [
    { label: 'manager', value: state.manager },
    { label: 'unit', value: state.path },
    // Written but not loaded is a real state: it starts at next login rather than now.
    {
      label: 'running',
      value:
        warning === undefined
          ? 'started now, and restarted if it stops'
          : context.style.warn(`not started now (${warning}); it starts at next login`),
    },
  ]);
  flow.close(`${state.manager} will start it at login.`);
  flow.hint('memnox daemon --uninstall   undoes this');
}

async function renderUninstalled(context: CliContext, home: string): Promise<void> {
  const { flow, style } = context;
  const { state, warning } = await uninstallService(home);
  if (!state.supported || state.path === '') {
    flow.close('Nothing was installed, so nothing was removed.');
    return;
  }
  // Said rather than assumed, so it never claims a stop while the process still runs.
  flow.rows('Removed', [
    { label: 'unit', value: state.path },
    {
      label: 'running',
      value:
        warning === undefined
          ? 'the running daemon was stopped'
          : style.warn(`it would not stop (${warning})`),
    },
  ]);
  flow.close('This machine no longer starts it.');
  if (warning !== undefined) {
    flow.hint('Find it with "pgrep -f memnox" and end it.');
  }
}

/** What the loop holds, read once when it starts. */
interface LoopState {
  daemon: MemnoxDaemon;
  /** The rule files in force, the same ones every seam reads. */
  files: string[];
  hasRules: boolean;
  budgets: number;
  account: Account | null;
  /** The rules in force, handed to the egress proxy so it rules the way the socket does. */
  gate?: LocalGate;
}

/** The loop the service runs: evaluate over a socket, sync on a heartbeat, answer held calls. */
async function runLoop(
  context: CliContext,
  home: () => string,
  options: DaemonOptions,
): Promise<void> {
  const state = await buildLoop(context, home(), options);
  const path = await state.daemon.listen(home());
  renderListening(context, path, state, options.sync);
  let running = true;
  // One log for everything this process says for as long as it lives.
  const log = (message: string): void => context.out.note(message);
  // Only where the machine is enrolled, because an edit claim is a workspace's to hold.
  const watcher = state.account === null ? null : new EditWatcher(home());
  // Local, and so whether or not the machine is enrolled: this is what setup asked it to hold.
  const keeper = new BoundaryKeeper(home(), { log });
  keeper.start();
  const egress = await startEgress(home(), state, log);
  if (state.account !== null) {
    // Rides here because this is already the one process that outlives a command.
    void syncLoop(home(), () => running, { log });
    watcher?.start();
  }
  // Held open deliberately: the command is the daemon, not a launcher for one.
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      running = false;
      watcher?.stop();
      keeper.stop();
      void Promise.all([state.daemon.close(), egress.stop()]).then(() => resolve());
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

/** The egress proxy, under the same rules the socket answers with, stopped with the daemon. */
async function startEgress(
  home: string,
  state: LoopState,
  log: (message: string) => void,
): Promise<DaemonEgress> {
  const egress = new DaemonEgress(home, {
    log,
    ...(state.gate === undefined ? {} : { gate: state.gate }),
  });
  const port = await egress.start();
  log(
    port === null
      ? 'The egress proxy did not start, so "memnox run" starts one per session.'
      : `Egress proxy on ${EGRESS_LOOPBACK}:${port}; "memnox run" points agents at it.`,
  );
  return egress;
}

async function buildLoop(
  context: CliContext,
  home: string,
  options: DaemonOptions,
): Promise<LoopState> {
  // The registry rather than the working directory, which is `/` under launchd and systemd.
  const set = await policySetInForce(home, options.file);
  const files = set.loaded.map((each) => each.file);
  const gate =
    files.length === 0 ? undefined : new LocalGate(set.policies, { agentName: 'agent' });
  // Read once here, so killing this process never clears a daily budget.
  const budgets = await readBudgets(home);
  const spending =
    budgets.length === 0
      ? {}
      : {
          budgets,
          spentAlready: await withEvents(home, (store) =>
            store.query({ limit: LEDGER_SCAN_LIMIT }),
          ),
          fleetSpend: await readFleetSpend(home),
        };
  const daemon = new MemnoxDaemon({
    ...(gate === undefined ? {} : { gate }),
    ...spending,
    pauses: new SessionPauses(home),
    // Commentary rather than rail steps, because it writes for as long as the process lives.
    log: (message) => context.out.note(message),
  });
  const account = options.sync ? await readAccount(home) : null;
  return {
    daemon,
    files,
    hasRules: gate !== undefined,
    budgets: budgets.length,
    account,
    ...(gate === undefined ? {} : { gate }),
  };
}

function describeSync(account: Account | null, syncWanted: boolean): string {
  if (account !== null) return `${account.baseUrl} as ${account.machineId}`;
  if (syncWanted) return 'not logged in, so nothing is pulled or sent';
  return 'off; this daemon talks to nothing';
}

function renderListening(
  context: CliContext,
  path: string,
  state: LoopState,
  syncWanted: boolean,
): void {
  const { flow, style } = context;
  flow.rows('Listening', [
    { label: 'socket', value: path },
    {
      label: 'rules',
      value: state.hasRules
        ? `from ${state.files.join(', ')}`
        : style.warn('no rule file is registered, so everything will be allowed'),
    },
    {
      label: 'budgets',
      value: state.budgets === 0 ? 'none set' : `${state.budgets} in force`,
    },
    { label: 'sync', value: describeSync(state.account, syncWanted) },
  ]);
  flow.close('Holding the rules. Ctrl-C to stop.');
  flow.hint('Interceptors fall back to in-process if this is not running.');
  if (state.account === null && syncWanted) {
    flow.hint('"memnox login" connects this machine.');
  }
}
