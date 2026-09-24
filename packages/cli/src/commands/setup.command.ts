/** `memnox setup`: this machine under Memnox with no account, and after `memnox login` its agents in the workspace too. */
import { homedir } from 'node:os';
import type { Command } from 'commander';
import type {
  Account,
  DiscoveryReport,
  EnvironmentSnapshot,
  SnapshotAgent,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { confirmOnTerminal, type Confirm } from '../confirm';
import { describeCount } from '../plural';
import { defaultScanSeams, scanMachine, type ScanSeams } from '../machine-scan';
import { connectMachine, type ConnectSeams } from '../sync/connect';
import { manageable, offboardAgent } from '../agents/onboard';
import { onboardedInto, readRecord } from '../agents/onboarding';
import { displayName, readNames, type AgentNames } from '../agents/names';
import { askOnTerminal, type NameAsker } from '../agents/name-prompt';
import { runPathLine } from '../protect/seam-install';
import { wireMachine, type Wiring, type WiringSeams } from '../setup-wiring';
import { reportScan } from './agents/shared';
import { connectedAccount } from './setup/plane';
import { offerOne, describeAgent } from './setup/offer';
import { askToProtect, describeMachine, renderLocalSummary } from './setup/local';
import {
  STATUS,
  renderSummary,
  describePlane,
  describeDaemon,
  describeEditors,
  describeMcp,
  type Result,
} from './setup/summary';

/** Everything `setup` needs, injected so a test needs no network, ledger or installer. */
export interface SetupDeps {
  context: CliContext;
  home: () => string;
  project: () => string;
  buildSeams: () => ScanSeams;
  connect: typeof connectMachine;
  ask: NameAsker;
  confirm: Confirm;
  interactive: () => boolean;
  connectSeams: ConnectSeams;
  reportScan: (home: string) => Promise<boolean>;
  offboard: typeof offboardAgent;
  wiringSeams: WiringSeams;
}

/** Everything but the context, for a test to swap; each has a real default. */
type SetupSeams = Omit<SetupDeps, 'context'>;

export interface SetupOptions {
  /** Only given to connect; without it setup is local, or stays on the plane it is on. */
  url?: string;
  /** Wires the machine without the one question, for a terminal nobody is at. */
  yes?: boolean;
  enforce?: boolean;
  name?: string;
  open: boolean;
  probe: boolean;
}

/** What the scan found, carried together because every offer reads both halves. */
export interface Scanned {
  report: DiscoveryReport;
  snapshot: EnvironmentSnapshot;
}

/**
 * Connects, scans, then offers each agent in turn with what it reaches shown first, because
 * a list of five names with one prompt under it is a screen people say yes to unread.
 * Every step calls the command that owns it, and prints through `Flow`, prompts included.
 */
export function registerSetupCommand(
  program: Command,
  context: CliContext,
  overrides: Partial<SetupSeams> = {},
): void {
  const deps: SetupDeps = {
    context,
    home: homedir,
    project: () => process.cwd(),
    buildSeams: () => defaultScanSeams(),
    connect: connectMachine,
    ask: askOnTerminal,
    confirm: confirmOnTerminal,
    interactive: () => process.stdin.isTTY === true,
    connectSeams: {},
    reportScan,
    offboard: offboardAgent,
    wiringSeams: {},
    ...overrides,
  };
  program
    .command('setup')
    .description(
      'See what your agents can reach and put this machine under Memnox, with no account',
    )
    .option('--url <base>', 'connect to this control plane too, as "memnox login" does')
    .option('-y, --yes', 'wire this machine without asking')
    .option('--enforce', 'start in enforce rather than observe')
    // For everything but a terminal, where it is asked: a machine enrolled unnamed is a hex id.
    .option('--name <name>', 'what your workspace calls this machine')
    .option('--no-open', 'print the code and the URL instead of opening a browser')
    .option('--no-probe', 'do not start any MCP server to ask what it offers')
    .action(async (options: SetupOptions) => runSetup(deps, options));
}

/**
 * Scan, then either govern the machine on its own or, where it is already connected, also
 * put each agent into the workspace. The local half never waits on a network.
 */
async function runSetup(deps: SetupDeps, options: SetupOptions): Promise<void> {
  const { context } = deps;
  context.flow.open('memnox setup');

  // Skipped when already done: the device flow on an enrolled machine mints a second credential.
  const account = await connectedAccount({ deps, options });
  const scanned = await findAgents(deps, options);
  if (scanned === null) return;
  if (account === null) return setUpLocally(deps, options, scanned);
  if (!deps.interactive() && options.yes !== true) {
    // Every question below waits on a person, so it names the non-interactive path instead.
    context.flow.close('Nothing is attached to this terminal, so nobody can be asked.');
    context.flow.hint(
      'Run "memnox setup --yes" to put every agent in under the name it already has.',
    );
    return;
  }

  const results = await offerEach(answering(deps), account, scanned);
  const wired = await wireAndRender(deps);

  // Onboarding writes credentials and the console's Agents page reads a census, so a
  // run that sent none would report governed agents onto an empty page.
  const reported = await deps.reportScan(deps.home()).catch(() => false);
  // The profile line is the one change asked for by name, so `--yes` does not make it.
  if (deps.interactive()) await offerPathLine(deps);
  renderSummary(context, { account, results, reported, wired });
}

/**
 * The same questions answered by `--yes` when nobody is at the terminal, which is an
 * agent running setup for its person: every agent in, under the name it already has.
 */
function answering(deps: SetupDeps): SetupDeps {
  if (deps.interactive()) return deps;
  return { ...deps, ask: async () => null, confirm: async () => true };
}

/** No account: what the agents reach, one question, the wiring, and nothing sent anywhere. */
async function setUpLocally(
  deps: SetupDeps,
  options: SetupOptions,
  scanned: Scanned,
): Promise<void> {
  describeMachine(deps, scanned);
  if (!(await askToProtect(deps, scanned, options.yes === true))) return;
  const wired = await wireAndRender(deps);
  if (deps.interactive()) await offerPathLine(deps);
  renderLocalSummary(deps, wired);
}

/**
 * Asked rather than written, because a tool that edits a shell profile unasked is not
 * trusted twice; without it an editor started from the dock meets no wrapper.
 */
async function offerPathLine(deps: SetupDeps): Promise<void> {
  const wanted = await deps.confirm(
    'Add the interceptors to your login PATH, so an editor started from the dock meets them too?',
  );
  if (wanted) await runPathLine(deps.context, false);
}

/** Scans, and says what it found; null when there is nothing to offer. */
async function findAgents(
  deps: SetupDeps,
  options: SetupOptions,
): Promise<Scanned | null> {
  const { flow } = deps.context;
  flow.step('Looking for agents on this machine');
  const scanned = await scanMachine(deps.buildSeams(), {
    probe: options.probe !== false,
  });
  const agents = scanned.snapshot.agents;
  if (agents.length === 0) {
    flow.close('No agents found on this machine.');
    flow.hint('Memnox governs agents it can see. Install one, then run this again.');
    return null;
  }
  const names = await readNames(deps.home());
  flow.step(
    `Found ${describeCount(agents.length, 'agent')}`,
    agents.map((agent) => displayName(names, agent)).join(', '),
  );
  return scanned;
}

/** Wires the machine, because consent is not wiring: until this runs nothing is in the path. */
async function wireAndRender(deps: SetupDeps): Promise<Wiring> {
  const wired = await wireMachine(deps.home(), deps.project(), deps.wiringSeams);
  // One line, because the counts are the point and four headings read as four events.
  deps.context.flow.step(
    'Wired this machine',
    `${wired.interceptors} interceptors, ${wired.rules} rules, ${describeDaemon(wired)}${describeEditors(wired)}${describeMcp(wired)}`,
  );
  return wired;
}

/** Walks the agents found, offering each one and collecting what became of it. */
async function offerEach(
  deps: SetupDeps,
  account: Account,
  scanned: Scanned,
): Promise<Result[]> {
  const results: Result[] = [];
  let names = await readNames(deps.home());
  for (const agent of scanned.snapshot.agents) {
    results.push(await offerAgent(deps, { account, scanned, agent, names }));
    names = await readNames(deps.home());
  }
  return results;
}

/** One agent, the run it belongs to, and what everything is called so far. */
interface AgentOffer {
  account: Account;
  scanned: Scanned;
  agent: SnapshotAgent;
  names: AgentNames;
}

/** One agent: already done, done elsewhere, ungovernable, or offered. */
async function offerAgent(deps: SetupDeps, offer: AgentOffer): Promise<Result> {
  const { context, home } = deps;
  const { account, scanned, agent, names } = offer;
  const name = displayName(names, agent);
  const already = await readRecord(home(), agent.id);

  if (already !== null && onboardedInto(already, account)) {
    return { name, status: STATUS.ALREADY, because: 'onboarded earlier' };
  }
  if (already !== null) {
    // Onboarded into another workspace: rewriting would back up a config already
    // pointing at the other plane, so it is said rather than onboarded over.
    return { name, status: STATUS.ELSEWHERE, because: describePlane(already) };
  }

  // Checked before anybody is asked, so nobody answers two questions for nothing.
  const config = await manageable(home(), deps.project(), agent.kind);
  const shown = { context, home: home(), agent, names, config, ...scanned };
  if (config.because !== undefined) {
    describeAgent(shown);
    return { name, status: STATUS.CANNOT, because: config.because };
  }
  return offerOne({
    ...shown,
    account,
    ask: deps.ask,
    confirm: deps.confirm,
    project: deps.project(),
  });
}
