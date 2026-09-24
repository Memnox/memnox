/**
 * `memnox update`: the version here against the latest published, the upgrade for how this
 * copy was installed run only after a yes, then the wiring again through the new install.
 */
import { homedir } from 'node:os';
import { Option, type Command } from 'commander';
import type { CliContext } from '../cli-context';
import { confirmOnTerminal, type Confirm } from '../confirm';
import { CLI_VERSION } from '../defaults';
import { readKept } from '../keeper/kept';
import { wireMachine, type Wiring } from '../setup-wiring';
import {
  installOf,
  isNewer,
  latestPublished,
  rewireThroughNewInstall,
  runAttached,
  runningEntry,
  type Install,
} from './update/install';

/** Every outside effect, so a test touches no network and runs no package manager. */
export interface UpdateDeps {
  home: () => string;
  project: () => string;
  installed: () => string;
  latest: () => Promise<string | null>;
  install: () => Install;
  confirm: Confirm;
  run: (command: readonly string[]) => Promise<boolean>;
  /** The wiring, run by the upgraded copy rather than this one, which is the old code. */
  rewire: () => Promise<boolean>;
  wire: (home: string, project: string) => Promise<Wiring>;
}

/** The versions and the upgrade, read once, so each step below is a plain branch. */
interface UpdatePlan {
  installed: string;
  latest: string;
  install: Install;
}

export function registerUpdateCommand(
  program: Command,
  context: CliContext,
  overrides: Partial<UpdateDeps> = {},
): void {
  const deps: UpdateDeps = {
    home: homedir,
    project: () => process.cwd(),
    installed: () => CLI_VERSION,
    latest: latestPublished,
    install: () => installOf(runningEntry()),
    confirm: confirmOnTerminal,
    run: runAttached,
    rewire: rewireThroughNewInstall,
    // The rules are left alone: an upgrade changes the program, never what it enforces.
    wire: (home, project) => wireMachine(home, project, { rules: async () => 0 }),
    ...overrides,
  };
  program
    .command('update')
    .description('Update Memnox to the latest version, and rewire this machine to it')
    .addOption(new Option('--rewire', 'rewire this machine to this install').hideHelp())
    .action(async (options: { rewire?: boolean }) =>
      options.rewire === true ? runRewire(context, deps) : runUpdate(context, deps),
    );
}

async function runUpdate(context: CliContext, deps: UpdateDeps): Promise<void> {
  const { flow, style } = context;
  flow.open('memnox update');
  const installed = deps.installed();
  const install = deps.install();
  const latest = await deps.latest();
  if (latest === null) {
    flow.rows('Memnox', [{ label: 'installed', value: installed }]);
    flow.close(
      style.warn('The latest version could not be looked up, so nothing changed.'),
    );
    flow.hint(`Online again, run "memnox update", or update by hand: ${install.display}`);
    return;
  }
  flow.rows('Memnox', [
    { label: 'installed', value: installed },
    { label: 'latest', value: latest },
    { label: 'installed with', value: install.method },
  ]);
  if (!isNewer(latest, installed)) {
    flow.close(style.ok(`This is the latest version, ${installed}.`));
    return;
  }
  await upgrade(context, deps, { installed, latest, install });
}

/** Asks, runs the upgrade, then rewires; each step that does not happen says what would. */
async function upgrade(
  context: CliContext,
  deps: UpdateDeps,
  plan: UpdatePlan,
): Promise<void> {
  const { flow, style } = context;
  const { command, display } = plan.install;
  if (command === null) {
    flow.close(`Memnox ${plan.latest} is out. Update with:`);
    flow.hint(display);
    return;
  }
  const wanted = await deps.confirm(
    `Update Memnox ${plan.installed} to ${plan.latest} with "${display}"?`,
  );
  if (!wanted) {
    flow.close('Nothing was changed.');
    flow.hint(`Update later with "memnox update", or by hand: ${display}`);
    return;
  }
  if (!(await deps.run(command))) {
    flow.close(
      style.warn('The update did not finish, so this is still the old version.'),
    );
    flow.hint(`Run it by hand to see why: ${display}`);
    return;
  }
  const setUp = (await readKept(deps.home())) !== null;
  const rewired = setUp && (await deps.rewire());
  flow.close(style.ok(`Memnox is now ${plan.latest}.`));
  if (setUp && !rewired)
    flow.hint('"memnox setup" points the hooks and the service at it.');
}

/** Run by the new copy: the same wiring setup draws, idempotent, pointed at this install. */
async function runRewire(context: CliContext, deps: UpdateDeps): Promise<void> {
  const { flow, style } = context;
  flow.open('memnox update');
  const wired = await deps.wire(deps.home(), deps.project());
  flow.step(
    'Rewired this machine',
    `${wired.interceptors} interceptors, hooks and the service point at ${deps.installed()}`,
  );
  flow.close(style.ok('This machine runs the new version.'));
}
