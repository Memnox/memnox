import { homedir } from 'node:os';
import type { Command } from 'commander';
import {
  discover,
  environmentMismatches,
  NodeMachineReader,
  rankAgents,
  runDoctor,
  type AgentStanding,
  type EnvironmentMismatch,
  type Finding,
  type MachineReader,
} from '@memnox/discovery';
import type { CliContext } from '../cli-context';

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
): void {
  program
    .command('doctor')
    .description(
      'What on this machine is risky, why, and the one change that closes each',
    )
    .option('--json', 'emit the findings as JSON')
    .option(
      '--by-agent',
      'the same findings per agent on this machine, never a rating of the products',
    )
    .action(async (options: { json?: boolean; byAgent?: boolean }) => {
      const reader: MachineReader = buildReader();
      // The same ground `memnox` covers: a finding it showed and doctor cannot
      // rank is a credential the reader was told about and never offered a fix for.
      const discovered = await discover(reader, {
        now: new Date().toISOString(),
        projectDirs: [cwd()],
      });
      const report = runDoctor({
        resources: discovered.resources,
        reachability: discovered.reachability,
        surfaces: discovered.surfaces,
      });

      const standings = rankAgents(report.findings, discovered.surfaces);
      /* Neither half is a finding on its own. An agent that reaches production while
         the work is happening in a local checkout is doing local work with production
         authority, and that pair is what is worth removing. */
      const mismatches = environmentMismatches(discovered, [cwd()]);

      if (options.json === true) {
        context.out.line(
          JSON.stringify({ ...report, agents: standings, mismatches }, null, 2),
        );
        return;
      }

      const { out, style } = context;
      if (options.byAgent === true) {
        renderByAgent(context, standings);
        return;
      }
      if (report.findings.length === 0 && mismatches.length === 0) {
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

      renderMismatches(context, mismatches);

      // A decomposition of this list, granting nothing and ranking against nobody.
      out.line(
        `Risk ${report.score.total}, from ${report.findings.length} finding(s) above. ` +
          'It grants nothing and compares this machine to no other.',
      );
    });
}

const AGENT_WIDTH = 16;

/**
 * Least privilege, stated as the one pair a scan can actually prove: this agent is
 * working here, and it can reach that. The recommendation is remove or protect, and a
 * person chooses which — narrowing it here would be hardening nobody asked for.
 */
function renderMismatches(
  context: CliContext,
  mismatches: readonly EnvironmentMismatch[],
): void {
  if (mismatches.length === 0) return;
  const { out, style } = context;
  out.line(style.bold('ENVIRONMENT MISMATCH'));
  out.line('');
  for (const mismatch of mismatches) {
    out.line(`  ${mismatch.agentKind}`);
    out.line(`  ${style.dim(`working in  ${mismatch.workingIn}`)}`);
    for (const resource of mismatch.reaches) {
      out.line(
        `  ${style.warn('!')}  reaches     ${resource.id} ${style.dim(`«${resource.declaredIn}»`)}`,
      );
    }
    out.line(`  ${style.dim('remove it, or protect it with: memnox harden')}`);
    out.line('');
  }
}

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
