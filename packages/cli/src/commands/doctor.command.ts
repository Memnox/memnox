/**
 * `memnox doctor`: what on this machine is risky, whether Memnox is wired to anything,
 * and whether the seams actually refuse. `--prove` wins over `--wiring` when both are passed.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import {
  chainsFor,
  CHECK,
  checkInstallation,
  discover,
  lastProbed,
  MEMNOX_HOME,
  NodeFindingsStore,
  type FindingsStore,
  NodeMachineReader,
  NodeSnapshotStore,
  rankAgents,
  RISK_LEVEL,
  runDoctor,
  PolicyEngine,
  DECISION_EFFECT,
  EXIT,
  type GovernedBy,
  summarizeHealth,
  withToolsFrom,
  type AgentStanding,
  type Finding,
  type HealthCheck,
  type MachineReader,
  type SnapshotStore,
  type SeamProof,
  type DoctorReport,
  type Surface,
  ACTION,
  agentNameIn,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { defaultScanSeams, scanMachine } from '../machine-scan';
import { renderServerHealth, serverHealthOf } from './doctor/servers';
import { describeCount } from '../plural';
import { TONE, type Tone } from '../flow';
import { policySetInForce } from '../policy-path';
import { readHealth } from '../health-probe';
import { proveEnforcement, type ProbeContext } from '../verify/enforcement';
import { renderEnforcement } from '../verify/enforcement-report';

const SEVERITY_WIDTH = 10;
const CHECK_WIDTH = 14;
// The action a credential finding is about, spelled the way `denyReadStep` writes it.
const FILESYSTEM_READ = ACTION.FILESYSTEM_READ;
// Asked for no agent in particular, because the finding is that any of them can read it.
const ANY_AGENT = 'any-agent';

/** The seams `doctor` reads the machine through, each replaceable in a test. */
interface DoctorSeams {
  buildReader: () => MachineReader;
  cwd: () => string;
  home: () => string;
  now: () => Date;
  buildSnapshots: () => SnapshotStore;
  buildFindings: () => FindingsStore;
  probe: (ctx: ProbeContext) => Promise<SeamProof[]>;
}

interface DoctorDeps extends DoctorSeams {
  context: CliContext;
}

interface DoctorOptions {
  json?: boolean;
  byAgent?: boolean;
  wiring?: boolean;
  prove?: boolean;
  servers?: boolean;
}

function defaultSeams(given: Partial<DoctorSeams>): DoctorSeams {
  const home = given.home ?? homedir;
  return {
    buildReader: () => new NodeMachineReader(home()),
    cwd: () => process.cwd(),
    home,
    now: () => new Date(),
    buildSnapshots: () => new NodeSnapshotStore(join(home(), MEMNOX_HOME)),
    buildFindings: () => new NodeFindingsStore(join(home(), MEMNOX_HOME)),
    probe: proveEnforcement,
    ...given,
  };
}

/** What on this machine is risky, whether Memnox is wired to anything, and whether the seams refuse. */
export function registerDoctorCommand(
  program: Command,
  context: CliContext,
  seams: Partial<DoctorSeams> = {},
): void {
  const deps: DoctorDeps = { context, ...defaultSeams(seams) };
  program
    .command('doctor')
    .description(
      'What on this machine is risky, why, and the one change that closes each',
    )
    .option('--json', 'emit the findings as JSON')
    .option(
      '--wiring',
      'whether Memnox is actually gating anything, rather than only installed',
    )
    .option(
      '--by-agent',
      'the same findings per agent on this machine, never a rating of the products',
    )
    .option(
      '--prove',
      'ask every seam to refuse something, and report what actually came back',
    )
    .option('--servers', 'start every MCP server and say which ones answer')
    .action(async (options: DoctorOptions) => runDoctorCommand(deps, options));
}

/**
 * Three questions behind one command: does a seam actually refuse, is Memnox wired to
 * anything, and what on this machine is reachable that should not be.
 */
async function runDoctorCommand(deps: DoctorDeps, options: DoctorOptions): Promise<void> {
  const { context } = deps;
  if (options.json !== true) context.flow.open('memnox doctor');
  // Before --wiring, because what actually happened matters more than what was configured.
  if (options.prove === true) {
    const proofs = await deps.probe({
      home: deps.home(),
      dir: deps.cwd(),
      env: process.env,
    });
    const status = renderEnforcement(context, proofs);
    if (status !== EXIT.OK) process.exitCode = status;
    return;
  }
  if (options.wiring === true) return runWiring(deps, options.json === true);
  if (options.servers === true) return runServers(deps, options.json === true);
  return runFindings(deps, options);
}

/** Starts each configured server, because a server that does not answer fails the agent. */
async function runServers(deps: DoctorDeps, asJson: boolean): Promise<void> {
  const { report } = await scanMachine(defaultScanSeams(deps.cwd()), { probe: true });
  const servers = serverHealthOf(report);
  if (asJson) {
    deps.context.out.json({ servers });
    return;
  }
  if (!renderServerHealth(deps.context, servers)) process.exitCode = EXIT.FAILED;
}

/** Whether the seams are installed, which is a different question from whether they bite. */
async function runWiring(deps: DoctorDeps, asJson: boolean): Promise<void> {
  const checks = checkInstallation(await readHealth(deps.home(), deps.cwd()));
  if (asJson) {
    deps.context.out.json({ ...summarizeHealth(checks), checks });
    return;
  }
  renderWiring(deps.context, checks);
}

/** What is reachable on this machine that should not be, and what closes each. */
async function runFindings(deps: DoctorDeps, options: DoctorOptions): Promise<void> {
  const { context } = deps;
  const { report, surfaces } = await diagnose(deps);
  await keepForSync(deps, report.findings);
  const standings = rankAgents(report.findings, surfaces);
  if (options.json === true) {
    context.out.json({ ...report, agents: standings });
    return;
  }
  if (options.byAgent === true) {
    renderByAgent(context, standings);
    return;
  }
  renderFindings(context, report);
}

/** The same ground bare `memnox` covers, so every finding it showed is one doctor can rank. */
async function diagnose(
  deps: DoctorDeps,
): Promise<{ report: DoctorReport; surfaces: Surface[] }> {
  const discovered = await discover(deps.buildReader(), {
    now: deps.now().toISOString(),
    projectDirs: [deps.cwd()],
  });
  // Doctor never starts an MCP server, so the tools come from the last scan that did.
  const surfaces = withToolsFrom(
    discovered.surfaces,
    lastProbed(await deps.buildSnapshots().history()),
  );
  const report = runDoctor({
    resources: discovered.resources,
    reachability: discovered.reachability,
    surfaces,
    // Asked of the engine, so a rule naming a directory closes the keys inside it.
    governedBy: await deniesReadsOf(deps.home()),
    // From the hydrated surfaces rather than the unprobed scan, or this is always empty.
    chains: chainsFor(
      discovered.agents.map((agent) => agent.id),
      surfaces,
    ),
  });
  return { report, surfaces };
}

/**
 * Kept so the sync pass can send it, and best effort: the scan is what the reader asked
 * for, and a machine that cannot write this still shows its report.
 */
async function keepForSync(
  deps: DoctorDeps,
  findings: readonly Finding[],
): Promise<void> {
  try {
    await deps.buildFindings().keep({
      takenAt: deps.now().toISOString(),
      findings: [...findings],
    });
  } catch (err) {
    deps.context.flow.aside(
      deps.context.style.dim(`findings not kept for sync: ${String(err)}`),
    );
  }
}

/** The findings themselves, with the fix beside each one that has one. */
function renderFindings(context: CliContext, report: DoctorReport): void {
  const { flow, style } = context;
  if (report.findings.length === 0) {
    flow.close('Nothing on this machine is reachable that should not be.');
    return;
  }

  flow.list(
    'What is reachable that should not be',
    report.findings.map((finding) => ({
      tone: finding.severity === RISK_LEVEL.LOW ? TONE.DIM : TONE.WARN,
      text: `${severity(style, finding)}${finding.title}`,
      detail: [
        // Skipped when the title already names it, or one file reads as two facts.
        finding.title.includes(finding.evidence) ? undefined : finding.evidence,
        finding.remediation === undefined
          ? undefined
          : `fix: ${finding.remediation.description}`,
      ],
    })),
  );

  // Counts, never a total: a number nobody can argue with is a number nobody acts on.
  const { counts } = report;
  flow.close(
    `${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low.`,
  );
  flow.hint('Nothing here compares this machine to another.');
  if (report.findings.some((finding) => finding.remediation !== undefined)) {
    flow.hint('Close what has a change behind it with "memnox protect".');
  }
}

/**
 * Five agents installed on five different days, put side by side. Ranked by what is
 * configured here, and never a safety rating of the products, which would be a claim
 * about software nobody tested.
 */
function renderByAgent(context: CliContext, standings: readonly AgentStanding[]): void {
  const { flow } = context;

  if (standings.length === 0) {
    flow.close('No agent on this machine has a finding against it.');
    return;
  }

  flow.list(
    'On this machine',
    standings.map((standing) => ({
      tone: standing.findings === 0 ? TONE.DIM : TONE.WARN,
      text: `${agentNameIn(standing.agentId)}  ${describeCount(standing.findings, 'finding')}`,
      detail: [
        standing.externalWriteTools > 0
          ? `${standing.externalWriteTools} tool(s) change external state`
          : undefined,
        standing.surfaces.length === 0 ? undefined : standing.surfaces.join(' · '),
      ],
    })),
  );
  flow.close(`${standings.length} agent(s) with something against them.`);
  flow.hint(
    'Ranked by what is configured here, not by the product. This is never a safety',
  );
  flow.hint('rating of software nobody in this room has tested.');
}

// Padded before it is styled, because `padEnd` counts the invisible escape sequence.
function severity(style: CliContext['style'], finding: Finding): string {
  return style.risk(
    finding.severity,
    finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH),
  );
}

/**
 * Installed and governing nothing is the state this exists to catch. Every line says
 * what is true, and every line that is not "ok" says the command that changes it.
 */
function renderWiring(context: CliContext, checks: readonly HealthCheck[]): void {
  const { flow, style } = context;
  const { state, headline } = summarizeHealth(checks);

  flow.list(
    'What is actually gating',
    checks.map((check) => ({
      tone: toneOf(check),
      text: `${check.name.padEnd(CHECK_WIDTH)}${check.detail}`,
      detail: [
        check.fix === undefined || check.state === CHECK.OK
          ? undefined
          : `→ ${check.fix}`,
      ],
    })),
  );
  flow.close(state === CHECK.OK ? style.ok(headline) : style.warn(headline));
  if (state !== CHECK.OK) {
    flow.hint(
      'Installed and governing nothing is the state this command exists to catch.',
    );
  }
}

function toneOf(check: HealthCheck): Tone {
  if (check.state === CHECK.OK) return TONE.OK;
  if (check.state === CHECK.INERT) return TONE.DIM;
  return TONE.WARN;
}

/**
 * Which rule in force already denies reading a path, so a closed finding reads as closed.
 * No rules, or rules that will not load, answer nothing and the finding keeps its severity.
 */
async function deniesReadsOf(home: string): Promise<GovernedBy> {
  let engine: PolicyEngine;
  try {
    const set = await policySetInForce(home);
    engine = new PolicyEngine(set.policies);
  } catch {
    // Unreadable rules are reported by `doctor --wiring`; here they mean ungoverned.
    return () => undefined;
  }
  return (path: string): string | undefined => {
    const verdict = engine.evaluate(
      { action: FILESYSTEM_READ, target: path },
      { agentName: ANY_AGENT },
    );
    if (verdict.effect !== DECISION_EFFECT.DENY) return undefined;
    return verdict.rule?.name ?? verdict.matchedPolicies[0]?.name;
  };
}
