/** `memnox agents discover`: scan this machine, name what it found, report it. */
import { readAccount, type Account, type SnapshotAgent } from '@memnox/core';
import type { CliContext } from '../../cli-context';
import { TONE } from '../../flow';
import { scanMachine } from '../../machine-scan';
import { askForNames } from '../../agents/name-prompt';
import { readNames, type AgentNames } from '../../agents/names';
import {
  applyNameFlags,
  countAgents,
  renderAgents,
  reportScan,
  surfacesOf,
  withNames,
  type AgentsDeps,
  type JsonOptions,
} from './shared';

export interface DiscoverOptions extends JsonOptions {
  ask?: boolean;
  name?: string[];
  probe?: boolean;
}

/** Scan, name what was found, and report it to the workspace if this machine has one. */
export async function runDiscover(
  deps: AgentsDeps,
  options: DiscoverOptions,
): Promise<void> {
  const { context, home, seams, interactive } = deps;
  const asJson = options.json === true;
  if (!asJson) context.flow.open('memnox agents discover');

  const { snapshot } = await scanMachine(seams(), { probe: options.probe !== false });
  const agents = snapshot.agents;
  let names = await applyNameFlags(
    deps,
    agents,
    await readNames(home()),
    options.name ?? [],
  );
  if (!asJson) renderAgents(context, `Found ${countAgents(agents)}`, agents, names);

  // Never when the answer is being piped: a prompt on a machine with no person at it
  // is a scan that hangs until somebody kills it.
  const asking = options.ask !== false && !asJson && interactive();
  if (asking && agents.length > 0) names = await askAndRenderNames(deps, agents, names);

  const account = await readAccount(home());
  // Through the same pass a sync does, which owns the cursor that stops a scan being sent twice.
  const reported = account === null ? false : await reportScan(home());

  if (asJson) {
    context.out.json({ agents: withNames(agents, names), reported });
    return;
  }
  renderDiscovered(context, agents, account, reported);
}

/** Walks the agents asking for names, and says which ones changed. */
async function askAndRenderNames(
  deps: AgentsDeps,
  agents: readonly SnapshotAgent[],
  names: AgentNames,
): Promise<AgentNames> {
  const { context, home } = deps;
  const renamed = await askForNames({
    context,
    home: home(),
    agents,
    names,
    detailOf: surfacesOf,
    ask: deps.ask,
  });
  if (renamed.length === 0) return names;
  context.flow.list(
    'Named',
    renamed.map((each) => ({ tone: TONE.OK, text: `${each.from} is now "${each.to}"` })),
  );
  return readNames(home());
}

function renderDiscovered(
  context: CliContext,
  agents: readonly SnapshotAgent[],
  account: Account | null,
  reported: boolean,
): void {
  const { flow } = context;
  flow.close(describeWhereItWent(agents, account, reported));
  if (account === null) {
    flow.hint('Connect this machine with "memnox login".');
  } else if (!reported) {
    flow.hint('Could not reach the control plane; the scan goes with the next sync.');
  }
  if (agents.length > 0) {
    flow.hint('rename one    memnox agents name <agent> <name>');
    flow.hint('put to work   memnox agents onboard <agent>');
  }
}

/** Where the scan ended up: on this machine only, sent, or waiting for the next sync. */
function describeWhereItWent(
  agents: readonly SnapshotAgent[],
  account: Account | null,
  reported: boolean,
): string {
  const here = countAgents(agents);
  if (account === null) return `${here} here, and nothing has left this machine.`;
  return reported
    ? `${here} here, reported to the control plane.`
    : `${here} here, kept for the next sync.`;
}
