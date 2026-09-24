/** One agent at a time: what it reaches, what to call it, and whether to put it to work. */
import {
  SENSITIVITY,
  type Account,
  type DiscoveryReport,
  type EnvironmentSnapshot,
  type SnapshotAgent,
} from '@memnox/core';
import type { CliContext } from '../../cli-context';
import { isYesOrNo, type Confirm } from '../../confirm';
import type { FlowRow } from '../../flow';
import { underHome } from '../../memnox-paths';
import { ONBOARD, onboardAgent, type Manageable } from '../../agents/onboard';
import { declineAgent } from '../../agents/declined';
import {
  displayName,
  setName,
  workspaceShown,
  type AgentNames,
} from '../../agents/names';
import type { NameAsker } from '../../agents/name-prompt';
import { buildEnrolReporter, describeProduct } from '../agents/shared';
import { STATUS, type Result } from './summary';

/** One agent as the scan found it, and the file onboarding would rewrite. */
interface DescribeInput {
  context: CliContext;
  home: string;
  agent: SnapshotAgent;
  names: AgentNames;
  report: DiscoveryReport;
  snapshot: EnvironmentSnapshot;
  config: Manageable;
}

/** The agent described, plus what it takes to ask about it and enrol it. */
interface OfferInput extends DescribeInput {
  account: Account;
  ask: NameAsker;
  confirm: Confirm;
  project: string;
}

/** Enough to make the point without the block becoming the screen. */
const SHOWN = 4;

/**
 * What it reaches, what to call it, and whether to put it to work, in that order, because
 * onboarding an agent that reads `~/.aws/credentials` is a different decision.
 */
export async function offerOne(input: OfferInput): Promise<Result> {
  const { context, home, agent } = input;
  const { flow, style } = context;
  describeAgent(input);
  const name = await askName(input);

  const yes = await input
    .confirm(`${flow.prompt}Put ${name} under Memnox now?`)
    .catch(() => false);
  if (!yes) {
    // Written down, or the census reports it as never asked about and the console
    // queues a decision that was just made.
    await declineAgent(home, agent.id);
    flow.aside(style.dim(`${name} was left alone.`));
    return { name, status: STATUS.SKIPPED, because: 'you said no' };
  }
  return enrol(input, name);
}

/** The name to enrol under: what was typed, or the current one when that was refused. */
async function askName(input: OfferInput): Promise<string> {
  const { context, home, agent, names, account } = input;
  const { flow, style } = context;
  const current = displayName(names, agent);
  // No name line in the question, because the block above already carries it.
  const wanted = await input
    .ask({
      shown: current,
      lines: [],
      gutter: flow.prompt,
      because: `Call it something ${workspaceShown(account.workspaceId)} will recognise`,
    })
    .catch(() => null);
  if (wanted === null) return current;
  if (isYesOrNo(wanted)) {
    // Nobody names an agent "y": it is an answer meant for the question below this one.
    flow.aside(
      style.warn(`Read "${wanted}" as an answer to the next question, not a name.`),
    );
    return current;
  }
  const written = await setName(home, agent.id, wanted);
  if (written.ok && written.name !== undefined) return written.name;
  flow.aside(
    style.warn(`Kept "${current}": ${written.because ?? 'that name was refused'}.`),
  );
  return current;
}

/** Onboards the agent, naming a failure and carrying on rather than losing earlier answers. */
async function enrol(input: OfferInput, name: string): Promise<Result> {
  const { context, home, agent, account } = input;
  const { flow, style } = context;
  const result = await onboardAgent({
    home,
    project: input.project,
    account,
    agentId: agent.id,
    agentKind: agent.kind,
    report: buildEnrolReporter(flow),
    shownAs: name,
  });
  if (result.outcome !== ONBOARD.DONE || result.record === undefined) {
    const because = result.because ?? 'no reason given';
    flow.aside(style.warn(`Did not onboard ${name}: ${because}`));
    return { name, status: STATUS.FAILED, because };
  }
  flow.rows(`${name} is under Memnox`, [
    { label: 'known as', value: `${name} in ${workspaceShown(account.workspaceId)}` },
    // Per agent, because this line makes the promise that nobody had to answer checkable.
    {
      label: 'enrolled',
      value:
        result.approvedInBrowser === true
          ? 'approved in your browser'
          : "on this machine's own credential, no browser",
    },
    { label: 'config', value: underHome(result.record.configPath, home) },
    { label: 'backup', value: underHome(result.record.backupPath, home) },
  ]);
  return { name, status: STATUS.ONBOARDED };
}

/**
 * What this agent is, what governs it, and what it can already reach, all proved by the
 * scan and none of it a claim about what Memnox will do.
 */
export function describeAgent(input: DescribeInput): void {
  const { context, home, agent, config } = input;
  const { style } = context;
  const rows: FlowRow[] = [
    { label: '', value: style.dim(describeProduct(agent)) },
    { label: 'id', value: agent.id },
  ];
  // The one file onboarding would rewrite, not every file the detector read.
  if (config.path !== undefined) {
    rows.push({ label: 'config', value: underHome(config.path, home) });
  }
  rows.push({ label: 'mcp', value: describeServers(input.snapshot, agent) });
  rows.push(...reachOf(agent, input.report, home));
  if (config.because !== undefined) {
    rows.push({ label: 'cannot manage', value: style.warn(config.because) });
  }
  context.flow.rows(displayName(input.names, agent), rows);
}

/** The servers in this agent's config, with a tool count only where something counted. */
function describeServers(snapshot: EnvironmentSnapshot, agent: SnapshotAgent): string {
  const servers = snapshot.servers.filter((server) => server.agentIds.includes(agent.id));
  if (servers.length === 0) return 'no servers configured';
  // `--no-probe` leaves the count at zero, and "github (0)" reads as a server with no tools.
  return servers
    .map((server) =>
      server.tools.length === 0 ? server.name : `${server.name} (${server.tools.length})`,
    )
    .join(', ');
}

/** What this agent can reach as the scan proved it, sensitive resources by name, no file opened. */
function reachOf(agent: SnapshotAgent, report: DiscoveryReport, home: string): FlowRow[] {
  const lines: FlowRow[] = [];
  const surfaces = [...new Set(agent.surfaces.map((surface) => surface.kind))];
  if (surfaces.length > 0) lines.push({ label: 'can use', value: surfaces.join(', ') });

  const sensitive = report.resources
    .filter((resource) => resource.sensitivity !== SENSITIVITY.ORDINARY)
    .filter((resource) => resource.reachableBy.some((ref) => ref.id === agent.id))
    .map((resource) => underHome(resource.path ?? resource.id, home));
  if (sensitive.length > 0) {
    const more = sensitive.length > SHOWN ? ` and ${sensitive.length - SHOWN} more` : '';
    lines.push({
      label: 'can reach',
      value: `${sensitive.slice(0, SHOWN).join(', ')}${more}`,
    });
  }
  if (lines.length === 0) {
    lines.push({ label: 'can reach', value: 'nothing this scan could prove' });
  }
  return lines;
}
