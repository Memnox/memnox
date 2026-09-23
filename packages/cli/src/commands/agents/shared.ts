/** What every `memnox agents` subcommand needs, and the helpers they and `setup` share. */
import type { Account, SnapshotAgent } from '@memnox/core';

import type { CliContext } from '../../cli-context';
import { describeCount } from '../../plural';
import { TONE, type Flow } from '../../flow';
import type { ScanSeams } from '../../machine-scan';
import type { NameAsker } from '../../agents/name-prompt';
import { askForOneName, parseNameFlag } from '../../agents/name-prompt';
import { onePass } from '../../sync/heartbeat';
import { acknowledgeControl, type ControlCommand } from '../../sync/control';
import type { EnrolReporter } from '../../agents/enrol-agent';
import { readRecord } from '../../agents/onboarding';
import {
  displayName,
  readNames,
  resolveAgent,
  setName,
  workspaceShown,
  type AgentNames,
} from '../../agents/names';

/** What every subcommand here needs, so each runner takes one argument instead of five. */
export interface AgentsDeps {
  context: CliContext;
  home: () => string;
  seams: () => ScanSeams;
  ask: NameAsker;
  interactive: () => boolean;
  project: () => string;
}

/** Shared by every subcommand: the machine-readable escape hatch. */
export interface JsonOptions {
  json?: boolean;
}

interface CloudNameInput {
  context: CliContext;
  home: string;
  agent: SnapshotAgent;
  names: AgentNames;
  account: Account;
  options: { json?: boolean; name?: string };
  interactive: boolean;
  ask: NameAsker;
}

/** An agent from the scan, with the name a person reads it by. */
interface CandidateRow {
  id: string;
  name: string;
  onboarded: boolean;
}

/** What onboarding is about to do, before the device code arrives unexplained. */
export function renderWhatWillHappen(
  context: CliContext,
  shown: string,
  kind: string,
  account: Account,
): void {
  const { flow, style } = context;
  flow.rows(`Onboarding ${shown}`, [
    { label: 'product', value: kind },
    {
      label: '1',
      value: `you say what ${workspaceShown(account.workspaceId)} should call this agent`,
    },
    { label: '2', value: 'you approve a credential for it in your browser' },
    { label: '3', value: "this machine copies the agent's config somewhere safe" },
    { label: '4', value: 'one server entry, called memnox, is added to it' },
  ]);
  // Said because whether authority changes is the fear at this moment.
  flow.aside(
    style.dim(
      'It does not change what this agent is allowed to do, and it is reversible.',
    ),
  );
}

/**
 * The name this agent will be known by in the workspace, written locally too.
 * Asked because the control plane hashes the hostname; `--name` answers for a script,
 * and with nobody at the machine the current name is kept rather than hanging.
 */
export async function chooseCloudName(input: CloudNameInput): Promise<{ name: string }> {
  const { context, home, agent, names, account, options } = input;
  const current = displayName(names, agent);

  if (options.name !== undefined) {
    const written = await setName(home, agent.id, options.name);
    if (written.ok && written.name !== undefined) return { name: written.name };
    renderKept(context, current, written.because ?? 'that name was refused');
    return { name: current };
  }
  if (options.json === true || !input.interactive) return { name: current };

  const workspace = workspaceShown(account.workspaceId);
  const chosen = await askForOneName({
    home,
    agent,
    names,
    because: `Call it something ${workspace} will recognise`,
    lines: [current, `This is the name ${workspace} will show for it from now on.`],
    ask: input.ask,
  });
  if (chosen.because !== undefined) renderKept(context, current, chosen.because);
  return { name: chosen.name };
}

/** Says a name was kept, and why the one offered was not taken. */
function renderKept(context: CliContext, current: string, because: string): void {
  context.flow.aside(context.style.warn(`Kept "${current}": ${because}.`));
}

/** Shown, then acknowledged, and in that order. */
export async function deliver(
  context: CliContext,
  account: Account,
  commands: readonly ControlCommand[],
): Promise<void> {
  context.flow.list(
    'What an operator has said',
    commands.map((command) => ({
      tone: TONE.OK,
      text: `${command.issuedBy} to ${command.agentId}: ${command.message}`,
      detail: [`${command.issuedAt} · ${command.id}`],
    })),
  );
  for (const command of commands) {
    // Received is all this can honestly claim: acting on it is whoever is at the agent.
    await acknowledgeControl(account, command.agentId, command.id, { ok: true });
  }
  context.flow.close(
    `${commands.length} message(s), marked received. Acting on them is yours.`,
  );
}

/** One agent this machine hosts, by name, id, bare id or product. */
export async function resolveHosted(
  deps: AgentsDeps,
  agent: string,
): Promise<SnapshotAgent | null> {
  const snapshot = await deps.seams().snapshots.latest();
  if (snapshot === null) return null;
  return resolveAgent(snapshot.agents, await readNames(deps.home()), agent);
}

/** The id of one agent by name, or of every agent this machine hosts. */
export async function resolveAddressed(
  deps: AgentsDeps,
  agent: string | undefined,
): Promise<string[]> {
  if (agent !== undefined) {
    const found = await resolveHosted(deps, agent);
    return [found === null ? agent : found.id];
  }
  const snapshot = await deps.seams().snapshots.latest();
  if (snapshot === null) return [];
  return snapshot.agents.map((each) => each.id);
}

/** True when the pass actually sent the scan; false is unreachable, not an error. */
export async function reportScan(home: string): Promise<boolean> {
  const pass = await onePass(home);
  if (pass.unreachable === true) return false;
  return pass.census !== undefined;
}

/** `--name claude-code="Backend Coder"`, applied before anything is printed. */
export async function applyNameFlags(
  deps: AgentsDeps,
  agents: readonly SnapshotAgent[],
  names: AgentNames,
  given: readonly string[],
): Promise<AgentNames> {
  let current = names;
  for (const raw of given) {
    const named = await applyNameFlag(deps, agents, current, raw);
    if (named === null) continue;
    current = { ...current, [named.id]: named.name };
  }
  return current;
}

/** One `--name` flag written, or said why it was ignored. */
async function applyNameFlag(
  deps: AgentsDeps,
  agents: readonly SnapshotAgent[],
  names: AgentNames,
  raw: string,
): Promise<{ id: string; name: string } | null> {
  const { context } = deps;
  const ignore = (because: string): null => {
    context.flow.aside(context.style.warn(`Ignored --name ${raw}: ${because}.`));
    return null;
  };
  const parsed = parseNameFlag(raw);
  if (parsed === null) return ignore('it has to read agent=name');
  const found = resolveAgent(agents, names, parsed.query);
  if (found === null) return ignore(`no agent called "${parsed.query}"`);
  const written = await setName(deps.home(), found.id, parsed.name);
  if (!written.ok || written.name === undefined) {
    return ignore(written.because ?? 'refused');
  }
  return { id: found.id, name: written.name };
}

/** Every agent that could be onboarded, when somebody typed the verb with no subject. */
export async function renderCandidates(
  deps: AgentsDeps,
  names: AgentNames,
  asJson: boolean,
): Promise<void> {
  const { context } = deps;
  const snapshot = await deps.seams().snapshots.latest();
  if (snapshot === null || snapshot.agents.length === 0) {
    renderNotScanned(context, asJson);
    return;
  }
  const rows = await readCandidates(deps.home(), snapshot.agents, names);
  if (asJson) {
    context.out.json({ agents: rows });
    return;
  }
  renderWaiting(
    context.flow,
    rows.filter((row) => !row.onboarded),
  );
}

async function readCandidates(
  home: string,
  agents: readonly SnapshotAgent[],
  names: AgentNames,
): Promise<CandidateRow[]> {
  const rows: CandidateRow[] = [];
  for (const agent of agents) {
    rows.push({
      id: agent.id,
      name: displayName(names, agent),
      onboarded: (await readRecord(home, agent.id)) !== null,
    });
  }
  return rows;
}

function renderWaiting(flow: Flow, waiting: readonly CandidateRow[]): void {
  if (waiting.length === 0) {
    flow.close('Every agent on this machine is already onboarded.');
    return;
  }
  flow.table(
    'Waiting to be put to work',
    ['Agent', 'Id'],
    waiting.map((row) => [row.name, row.id]),
  );
  flow.close(`${waiting.length} agent(s) are not under Memnox.`);
  flow.hint(`memnox agents onboard ${quoted(waiting[0]?.name ?? '<agent>')}`);
}

/** No kept scan to read from, said in whichever shape was asked for. */
export function renderNotScanned(context: CliContext, asJson: boolean): void {
  if (asJson) {
    context.out.json({ agents: [] });
    return;
  }
  context.flow.close('This machine has not been scanned yet.');
  context.flow.hint('Run "memnox agents discover".');
}

export function renderNotFound(
  context: CliContext,
  agent: string,
  asJson: boolean,
): void {
  if (asJson) {
    context.out.json({ agent: null });
    return;
  }
  context.flow.close(`No agent called "${agent}" was found on this machine.`);
  context.flow.hint('Run "memnox agents list" to see what is here.');
}

export function renderAgents(
  context: CliContext,
  title: string,
  agents: readonly SnapshotAgent[],
  names: AgentNames,
): void {
  if (agents.length === 0) {
    context.flow.step(title, 'no agents found on this machine');
    return;
  }
  context.flow.table(
    title,
    ['Agent', 'Reaches'],
    agents.map((agent) => [displayName(names, agent), surfacesOf(agent)]),
  );
}

/** The same rows, plus whether each is actually working under Memnox yet. */
export async function renderAgentsWithWork(
  context: CliContext,
  home: string,
  agents: readonly SnapshotAgent[],
  names: AgentNames,
): Promise<void> {
  if (agents.length === 0) {
    context.flow.step('On this machine', 'no agents found');
    return;
  }
  const rows: string[][] = [];
  for (const agent of agents) {
    const onboarded = (await readRecord(home, agent.id)) !== null;
    rows.push([
      displayName(names, agent),
      surfacesOf(agent),
      onboarded ? context.style.ok('onboarded') : context.style.dim('not onboarded'),
    ]);
  }
  context.flow.table('On this machine', ['Agent', 'Reaches', 'Working'], rows);
}

/** What this agent reaches, as the scan proved it, or the product, since a blank reads as a bug. */
export function surfacesOf(agent: SnapshotAgent): string {
  if (agent.surfaces.length === 0) return `${agent.kind}, no surface proved`;
  return [...new Set(agent.surfaces.map((surface) => surface.kind))].join(', ');
}

/** "1 agent" or "3 agents", for the lines that count what a scan found. */
export function countAgents(agents: readonly SnapshotAgent[]): string {
  return describeCount(agents.length, 'agent');
}

export function withNames(
  agents: readonly SnapshotAgent[],
  names: AgentNames,
): (SnapshotAgent & { name: string })[] {
  return agents.map((agent) => ({ ...agent, name: displayName(names, agent) }));
}

/** A name with a space in it has to be typed back with quotes around it. */
export function quoted(name: string): string {
  return /\s/.test(name) ? `"${name}"` : name;
}

/** Commander's collector for a repeatable flag. */
export function collect(value: string, previous: readonly string[]): string[] {
  return [...previous, value];
}

/** The product and, where the detector found one, its version. */
export function describeProduct(agent: SnapshotAgent): string {
  return agent.version === undefined ? agent.kind : `${agent.kind} ${agent.version}`;
}

/** The one question enrolment can ask, on the rail, because stdout would put it in a pipe. */
export function buildEnrolReporter(flow: Flow): EnrolReporter {
  return {
    approve: ({ what, url, code, because, deadline }) => {
      flow.step(`Approve ${what} in your browser`, url);
      if (code !== undefined) flow.value('Your code', code);
      // The reason first, because nothing before this said a browser would be needed.
      flow.aside(because);
      flow.aside(
        `Waiting for you to answer it, for ${deadline}. Ctrl+C stops, and nothing will change.`,
      );
    },
  };
}
