/** `memnox agents list`: what this machine hosts, from the kept scan. */
import { readNames } from '../../agents/names';
import {
  countAgents,
  renderAgentsWithWork,
  renderNotScanned,
  withNames,
  type AgentsDeps,
  type JsonOptions,
} from './shared';

/** What this machine hosts, from the kept scan. */
export async function runList(deps: AgentsDeps, options: JsonOptions): Promise<void> {
  const { context, home, seams } = deps;
  const { flow } = context;
  const asJson = options.json === true;
  if (!asJson) flow.open('memnox agents list');

  // The kept scan, never a fresh one: a scan starts every MCP server it finds and takes
  // seconds, and listing is the thing somebody runs twice in a row.
  const snapshot = await seams().snapshots.latest();
  if (snapshot === null) {
    renderNotScanned(context, asJson);
    return;
  }

  const names = await readNames(home());
  if (asJson) {
    context.out.json({
      agents: withNames(snapshot.agents, names),
      takenAt: snapshot.takenAt,
    });
    return;
  }
  await renderAgentsWithWork(context, home(), snapshot.agents, names);
  flow.close(`${countAgents(snapshot.agents)} on this machine.`);
  flow.hint(`from the scan taken ${snapshot.takenAt}`);
}
