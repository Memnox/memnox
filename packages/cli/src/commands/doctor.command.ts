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
  NodeMachineReader,
  NodeSnapshotStore,
  rankAgents,
  runDoctor,
  summarizeHealth,
  withToolsFrom,
  type AgentStanding,
  type Finding,
  type HealthCheck,
  type MachineReader,
  type SnapshotStore,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { gatherHealth } from '../health-probe';

const SEVERITY_WIDTH = 10;

/**
 * Each finding names the agent, the resource, the evidence and the one change that
 * closes it. No estimated loss, ever, and no rank against anybody else's machine.
 */
export function registerDoctorCommand(
  program: Command,
  context: CliContext,
  buildReader: () => MachineReader = () => new NodeMachineReader(homedir()),
  cwd: () => string = () => process.cwd(),
  buildSnapshots: () => SnapshotStore = () =>
    new NodeSnapshotStore(join(homedir(), MEMNOX_HOME)),
): void {
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
    .action(async (options: { json?: boolean; byAgent?: boolean; wiring?: boolean }) => {
      if (options.wiring === true) {
        const checks = checkInstallation(await gatherHealth(homedir(), cwd()));
        if (options.json === true) {
          context.out.json({ ...summarizeHealth(checks), checks });
          return;
        }
        renderWiring(context, checks);
        return;
      }
      const reader: MachineReader = buildReader();
      // The same ground `memnox` covers: a finding it showed and doctor cannot
      // rank is a credential the reader was told about and never offered a fix for.
      const discovered = await discover(reader, {
        now: new Date().toISOString(),
        projectDirs: [cwd()],
      });
      /* Doctor never starts an MCP server, so the tools come from the last scan that
         did. Without them every tool-shaped finding here is unreachable however true
         it is, and the reader is told about a credential with no fix beside it. */
      const surfaces = withToolsFrom(
        discovered.surfaces,
        lastProbed(await buildSnapshots().history()),
      );
      const report = runDoctor({
        resources: discovered.resources,
        reachability: discovered.reachability,
        surfaces,
        // From the hydrated surfaces, not the unprobed scan, or this is always empty.
        chains: chainsFor(
          discovered.agents.map((agent) => agent.id),
          surfaces,
        ),
      });

      const standings = rankAgents(report.findings, surfaces);

      if (options.json === true) {
        context.out.json({ ...report, agents: standings });
        return;
      }

      const { out, style } = context;
      if (options.byAgent === true) {
        renderByAgent(context, standings);
        return;
      }
      if (report.findings.length === 0) {
        out.line('Nothing on this machine is reachable that should not be.');
        return;
      }

      out.line(style.bold('MEMNOX DOCTOR'));
      out.line('');
      for (const finding of report.findings) {
        out.line(`  ${severity(style, finding).padEnd(SEVERITY_WIDTH)}${finding.title}`);
        out.line(`  ${' '.repeat(SEVERITY_WIDTH)}${style.dim(finding.evidence)}`);
        const remediation = finding.remediation;
        if (remediation !== undefined) {
          out.line(
            `  ${' '.repeat(SEVERITY_WIDTH)}${style.dim(`fix: ${remediation.description}`)}`,
          );
        }
        out.line('');
      }

      // Counts, never a total: a number nobody can argue with is a number nobody acts on.
      const { counts } = report;
      out.line(
        `${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ` +
          `${counts.low} low. Nothing here compares this machine to another.`,
      );
    });
}

const AGENT_WIDTH = 16;

/**
 * Five agents installed on five different days, put side by side. Ranked by what is
 * configured here — never a safety rating of the products, which would be a claim
 * about software nobody tested.
 */
function renderByAgent(context: CliContext, standings: readonly AgentStanding[]): void {
  const { out, style } = context;
  out.line('');
  out.line(style.bold('ON THIS MACHINE'));
  out.line('');

  if (standings.length === 0) {
    out.line('  No agent on this machine has a finding against it.');
    out.line('');
    return;
  }

  for (const standing of standings) {
    const name = standing.agentId.replace('agt_', '');
    out.line(
      `  ${style.bold(name.padEnd(AGENT_WIDTH))}${standing.findings} finding${standing.findings === 1 ? '' : 's'}`,
    );
    if (standing.externalWriteTools > 0) {
      out.line(
        `  ${''.padEnd(AGENT_WIDTH)}${style.warn(`${standing.externalWriteTools} tool(s) change external state`)}`,
      );
    }
    if (standing.surfaces.length > 0) {
      out.line(`  ${''.padEnd(AGENT_WIDTH)}${style.dim(standing.surfaces.join(' · '))}`);
    }
    out.line('');
  }

  out.line(
    style.dim(
      'Ranked by what is configured here, not by the product. This is never a safety',
    ),
  );
  out.line(style.dim('rating of software nobody in this room has tested.'));
  out.line('');
}

function severity(style: CliContext['style'], finding: Finding): string {
  return style.risk(finding.severity, finding.severity.toUpperCase());
}

const CHECK_WIDTH = 14;

/**
 * Installed and governing nothing is the state this exists to catch. Every line says
 * what is true, and every line that is not "ok" says the command that changes it.
 */
function renderWiring(context: CliContext, checks: readonly HealthCheck[]): void {
  const { out, style } = context;
  const { state, headline } = summarizeHealth(checks);

  out.line('');
  out.line(state === CHECK.OK ? style.ok(headline) : style.warn(headline));
  out.line('');

  for (const check of checks) {
    const mark =
      check.state === CHECK.OK
        ? style.ok('ok  ')
        : check.state === CHECK.INERT
          ? style.warn('idle')
          : style.warn('!   ');
    out.line(`  ${mark}  ${check.name.padEnd(CHECK_WIDTH)}${check.detail}`);
    if (check.fix !== undefined && check.state !== CHECK.OK) {
      out.line(`        ${''.padEnd(CHECK_WIDTH)}${style.dim(`→ ${check.fix}`)}`);
    }
  }
  out.line('');
}
