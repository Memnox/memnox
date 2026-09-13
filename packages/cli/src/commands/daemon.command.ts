import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import { LocalGate } from '@memnox/core';
import type { CliContext } from '../cli-context';
import { readBudgets, readFleetSpend, SessionPauses } from '@memnox/core';
import { MemnoxDaemon } from '../daemon-server';
import { withEvents } from '../event-store';
import { resolvePolicyFile } from '../policy-path';
import { readAccount } from '@memnox/core';
import { syncLoop } from '../sync/heartbeat';
import { installService, serviceState, uninstallService } from '../daemon/service';

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
    .action(
      async (options: {
        file?: string;
        sync: boolean;
        install?: boolean;
        uninstall?: boolean;
        status?: boolean;
      }) => {
        context.flow.open('memnox daemon');
        if (options.status === true) return sayStatus(context, home());
        if (options.uninstall === true) return sayUninstalled(context, home());
        if (options.install === true) return sayInstalled(context, home());
        return runDaemon(context, home, options);
      },
    );
}

/**
 * Whether anything starts this without a person. A daemon that only runs while somebody
 * keeps a terminal open is a heartbeat that stops the first time they close their laptop
 * lid, and every screen upstream goes on saying the machine is fine.
 */
function sayStatus(context: CliContext, home: string): void {
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

async function sayInstalled(context: CliContext, home: string): Promise<void> {
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

async function sayUninstalled(context: CliContext, home: string): Promise<void> {
  const { flow, style } = context;
  const { state, warning } = await uninstallService(home);
  if (!state.supported || state.path === '') {
    flow.close('Nothing was installed, so nothing was removed.');
    return;
  }
  /* Said rather than assumed. Claiming it stopped while the process it started is still
     running is the one thing this command must not do. */
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

async function runDaemon(
  context: CliContext,
  home: () => string,
  options: { file?: string; sync: boolean },
): Promise<void> {
  const { flow, style } = context;
  const file = resolvePolicyFile(options.file);
  const gate = existsSync(file)
    ? await LocalGate.fromFiles([file], { agentName: 'agent' })
    : undefined;

  /* Read once, here: a daily budget that reset whenever this process did would be
       a budget anybody could clear by killing it. */
  const budgets = await readBudgets(home());
  const spentAlready =
    budgets.length === 0
      ? []
      : await withEvents(home(), (store) => store.query({ limit: 20_000 }));

  const daemon = new MemnoxDaemon({
    ...(gate === undefined ? {} : { gate }),
    ...(budgets.length === 0
      ? {}
      : { budgets, spentAlready, fleetSpend: await readFleetSpend(home()) }),
    pauses: new SessionPauses(home()),
    /* The daemon's own log stays commentary on stderr rather than becoming rail
       steps: it writes while this process lives, and a rail that grew a step per
       connection would never reach its closing line. */
    log: (message) => context.out.note(message),
  });

  const path = await daemon.listen(home());

  /* The sync rides here rather than in its own process: this is already the
       one thing that outlives a command, and a second daemon is a second thing
       to notice has died. With no account it makes no call at all. */
  let running = true;
  const account = options.sync ? await readAccount(home()) : null;

  flow.rows('Listening', [
    { label: 'socket', value: path },
    {
      label: 'rules',
      value:
        gate === undefined
          ? style.warn(`none at ${file}, so everything will be allowed`)
          : `from ${file}`,
    },
    {
      label: 'budgets',
      value: budgets.length === 0 ? 'none set' : `${budgets.length} in force`,
    },
    {
      label: 'sync',
      value:
        account === null
          ? options.sync
            ? 'not logged in, so nothing is pulled or sent'
            : 'off; this daemon talks to nothing'
          : `${account.baseUrl} as ${account.machineId}`,
    },
  ]);
  flow.close('Holding the rules. Ctrl-C to stop.');
  flow.hint('Interceptors fall back to in-process if this is not running.');
  if (account === null && options.sync) {
    flow.hint('"memnox login" connects this machine.');
  }

  if (account !== null) {
    void syncLoop(home(), () => running, {
      log: (message) => context.out.note(message),
    });
  }

  // Held open deliberately: the command is the daemon, not a launcher for one.
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      running = false;
      void daemon.close().then(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
