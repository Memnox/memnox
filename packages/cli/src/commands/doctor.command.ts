import { homedir } from 'node:os';
import type { Command } from 'commander';
import {
  discover,
  NodeMachineReader,
  runDoctor,
  type Finding,
  type MachineReader,
} from '@memnox/discovery';
import type { CliContext } from '../cli-context';
import type { MachineReaderFactory } from './discover.command';

const SEVERITY_WIDTH = 10;

/**
 * Each finding names the agent, the resource, the evidence and the one change that
 * closes it. No estimated loss, ever, and no rank against anybody else's machine.
 */
export function registerDoctorCommand(
  program: Command,
  context: CliContext,
  buildReader: MachineReaderFactory = () => new NodeMachineReader(homedir()),
): void {
  program
    .command('doctor')
    .description(
      'What on this machine is risky, why, and the one change that closes each',
    )
    .option('--json', 'emit the findings as JSON')
    .action(async (options: { json?: boolean }) => {
      const reader: MachineReader = buildReader();
      const discovered = await discover(reader, { now: new Date().toISOString() });
      const report = runDoctor({
        resources: discovered.resources,
        reachability: discovered.reachability,
        surfaces: discovered.surfaces,
      });

      if (options.json === true) {
        context.out.line(JSON.stringify(report, null, 2));
        return;
      }

      const { out, style } = context;
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

      // A decomposition of this list, granting nothing and ranking against nobody.
      out.line(
        `Risk ${report.score.total}, from ${report.findings.length} finding(s) above. ` +
          'It grants nothing and compares this machine to no other.',
      );
    });
}

function severity(style: CliContext['style'], finding: Finding): string {
  return style.risk(finding.severity, finding.severity.toUpperCase());
}
