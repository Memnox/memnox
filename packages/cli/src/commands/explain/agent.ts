/** One agent: what it reaches, what holds it, and the chains its tools add up to. */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  combinedCapabilities,
  coverageFor,
  coverageSummary,
  SEAM_STATE,
  describeCombined,
  describeReach,
  DORMANT_AFTER_DAYS,
} from '@memnox/core';
import type {
  Harness,
  CombinedCapability,
  CoverageFacts,
  DiscoveredAgent,
  DiscoveryReport,
  EnvironmentSnapshot,
  SeamCoverage,
} from '@memnox/core';
import type { CliContext } from '../../cli-context';
import { TONE, type FlowRow } from '../../flow';
import { readHealth } from '../../health-probe';
import { guardProfilePath } from '../../memnox-paths';
import { holdsOwnPolicyHook } from '../../protect/agent-hooks';
import { DEFAULT_SHELL, loginPathConfigured } from '../../protect/shell-profile';
import { offboardCommand, type NamedDormant } from '../../keeper/keep-dormant';
import type { ScanSeams } from '../../machine-scan';
import type { Style } from '../../style';

/** Any one of these set means egress is going through a proxy something can observe. */
const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy'] as const;

interface RenderAgentInput {
  agent: DiscoveredAgent;
  report: DiscoveryReport;
  /** The last scan that asked the servers, or null when none has. */
  last: EnvironmentSnapshot | null;
  facts: CoverageFacts;
  /** Present when the agent has sat idle a month while holding reach. */
  dormant?: NamedDormant;
  asJson: boolean;
}

/** Where coverage is read from: this directory, this home and this environment. */
interface CoverageFactsInput {
  dir: string;
  home: string;
  env: NodeJS.ProcessEnv;
  /** The agent's kind, since its own hook is in its own settings file. */
  agent: string;
}

/** What a harness runs rather than what it is, and what holds the agent right now. */
export function renderAgent(context: CliContext, input: RenderAgentInput): void {
  const { agent, report, last, facts } = input;
  const harness = report.harnesses.find((each) => each.agentId === agent.id) ?? null;
  const combined = combinedFor(agent.id, last);
  const coverage = coverageFor(agent.kind, agent.id, report.surfaces, facts);
  const dormant = input.dormant ?? null;
  if (input.asJson) {
    context.out.json({ agent, harness, combined, coverage, dormant });
    return;
  }

  const what = harness === null ? 'agent' : 'harness, runs other agents';
  context.flow.rows(`${agent.kind}, ${what}`, [
    ...harnessRows(harness, context.style),
    ...reachRows(agent, report),
    ...dormantRows(dormant, context.style),
  ]);
  renderCombined(context, combined, last);
  renderCoverage(context, agent, coverage);
  // A harness filters its own tools; what it cannot see is what lies underneath it.
  if (harness !== null) {
    context.flow.hint(
      `${agent.kind} enforces its own tool policy. Memnox governs what it reaches underneath.`,
    );
  }
}

/** Only a harness has these, and printing them empty for Cursor would imply it might have. */
function harnessRows(harness: Harness | null, style: Style): FlowRow[] {
  if (harness === null) return [];
  const rows: FlowRow[] = [
    { label: 'runs', value: listOr(harness.runtimes, 'nothing this scan could name') },
    {
      label: 'roles',
      value:
        harness.roles.length === 0
          ? 'none defined on this disk'
          : `${harness.roles.length}: ${harness.roles.join(', ')}`,
    },
    {
      label: 'hooks',
      value: listOr(harness.hooks, 'none installed into another product'),
    },
  ];
  if (harness.federated) {
    rows.push({
      label: 'federated',
      value: style.warn('works with agents on machines this scan cannot see'),
    });
  }
  return rows;
}

/** Where the agent is declared, which surfaces it holds, and whether a shell is one of them. */
function reachRows(agent: DiscoveredAgent, report: DiscoveryReport): FlowRow[] {
  const own = report.surfaces.filter((surface) => surface.agentId === agent.id);
  const servers = [
    ...new Set(
      own.flatMap((surface) => (surface.servers ?? []).map((server) => server.name)),
    ),
  ];
  // The shell is why a tool list understates a coding agent, so it is said out loud.
  const viaShell = report.reachability.find(
    (each) => each.agentId === agent.id,
  )?.viaShell;
  return [
    { label: 'declared in', value: agent.configPaths.join(', ') },
    { label: 'surfaces', value: [...new Set(own.map((each) => each.kind))].join(', ') },
    { label: 'mcp servers', value: listOr(servers, 'none declared in its config') },
    ...(viaShell === true
      ? [{ label: 'shell', value: 'holds one, which reaches everything you can' }]
      : []),
  ];
}

/** Said beside the reach, because idle reach is the case for taking it away. */
function dormantRows(dormant: NamedDormant | null, style: Style): FlowRow[] {
  if (dormant === null) return [];
  return [
    {
      label: 'dormant',
      value: style.warn(
        `nothing in the ledger for ${DORMANT_AFTER_DAYS} days, still holding ${describeReach(dormant.reach)}. "${offboardCommand(dormant.name)}" retires it`,
      ),
    },
  ];
}

function renderCombined(
  context: CliContext,
  combined: readonly CombinedCapability[],
  last: EnvironmentSnapshot | null,
): void {
  if (combined.length > 0) {
    context.flow.list(
      'Combined capability',
      combined.map((capability) => ({
        tone: TONE.WARN,
        text: capability.consequence,
        detail: [describeCombined(capability)],
      })),
    );
    return;
  }
  if (last === null) {
    context.flow.step(
      'Combined capability',
      'no scan here has asked the servers, so no chain is shown. Run "memnox scan --save"',
    );
  }
}

/** Per agent, because a wrapped agent and an unwrapped one average to a number nobody can act on. */
function renderCoverage(
  context: CliContext,
  agent: DiscoveredAgent,
  coverage: readonly SeamCoverage[],
): void {
  const { flow, style } = context;
  const { held, total } = coverageSummary(coverage);
  flow.list(
    `Governed by ${held} of ${total} seam(s)`,
    coverage
      .filter((seam) => seam.state !== SEAM_STATE.NOT_APPLICABLE)
      .map((seam) => ({
        tone: seam.state === SEAM_STATE.HELD ? TONE.OK : TONE.WARN,
        text: `${seam.surface}  ${seam.detail}`,
        detail: [seam.next === undefined ? undefined : `→ ${seam.next}`],
      })),
  );
  flow.close(
    held === total
      ? style.ok(`${agent.kind} is held by all ${total} seam(s).`)
      : style.warn(`${agent.kind} is held by ${held} of ${total} seam(s).`),
  );
}

function listOr(values: readonly string[], empty: string): string {
  return values.length === 0 ? empty : values.join(', ');
}

/** The tools this agent reached in the last probed scan, and what they add up to. */
function combinedFor(
  agentId: string,
  last: EnvironmentSnapshot | null,
): CombinedCapability[] {
  if (last === null) return [];
  return combinedCapabilities(
    last.servers
      .filter((server) => server.agentIds.includes(agentId))
      .flatMap((server) =>
        server.tools.map((tool) => ({
          server: server.name,
          name: tool.name,
          effect: tool.effect,
          inferredFrom: 'name' as const,
        })),
      ),
  );
}

/**
 * The most recent snapshot that actually enumerated tools. The newest is usually this
 * run's own unprobed one, which would report every harness as holding no tools.
 */
export async function readLastProbedScan(
  seams: ScanSeams,
): Promise<EnvironmentSnapshot | null> {
  const history = await seams.snapshots.history();
  const probed = [...history]
    .reverse()
    .find((snapshot) => snapshot.servers.some((server) => server.tools.length > 0));
  return probed ?? null;
}

/** The facts coverage is decided from, read fresh, so wiring something up changes the answer. */
export async function readCoverageFacts(
  input: CoverageFactsInput,
): Promise<CoverageFacts> {
  const { dir, home, env, agent } = input;
  const health = await readHealth(home, dir, env);
  return {
    interceptorsInstalled: health.interceptorsInstalled.length > 0,
    interceptorsFirstOnPath: health.interceptorDirFirstOnPath,
    gitHooksInstalled: existsSync(join(dir, '.git', 'hooks', 'pre-push')),
    osGuardWritten: existsSync(guardProfilePath(home)),
    egressProxySet: PROXY_VARS.some((name) => (env[name] ?? '') !== ''),
    loginPathConfigured: await loginPathConfigured(env['SHELL'] ?? DEFAULT_SHELL, home),
    rulesRegistered: health.registeredFiles.length > 0,
    ownPolicyHook: await holdsOwnPolicyHook(home, agent),
  };
}
