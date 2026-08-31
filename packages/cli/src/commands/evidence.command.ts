import type { Command } from 'commander';
import {
  CONTROL_MAPPINGS,
  CONTROL_STATUS,
  FRAMEWORK,
  controlsFor,
  readinessFor,
  type ControlMapping,
  type Framework,
} from '@memnox/core';
import { renderComplianceReportMarkdown, type ComplianceReport } from '@memnox/runtime';
import type { CliContext } from '../cli-context';
import { DEFAULT_BASE_URL } from '../defaults';

const FORMAT_MARKDOWN = 'md';
const FORMAT_JSON = 'json';

const FRAMEWORKS: Framework[] = Object.values(FRAMEWORK);

const FRAMEWORK_LABEL: Record<Framework, string> = {
  [FRAMEWORK.SOC2]: 'SOC 2',
  [FRAMEWORK.ISO_27001]: 'ISO/IEC 27001',
  [FRAMEWORK.HIPAA]: 'HIPAA',
  [FRAMEWORK.GDPR]: 'GDPR',
};

const STATUS_LABEL: Record<string, string> = {
  [CONTROL_STATUS.IMPLEMENTED]: 'implemented',
  [CONTROL_STATUS.PARTIAL]: 'partial',
  [CONTROL_STATUS.PLANNED]: 'not built',
  [CONTROL_STATUS.ORGANIZATIONAL]: 'organizational',
};

/** Printed on every rendering, because the whole risk here is being read as a certificate. */
const DISCLAIMER = [
  'This is a self-assessment of implemented controls, not an audit result.',
  'SOC 2 and ISO 27001 require an auditor; HIPAA and GDPR have no certification.',
];

/**
 * What you can hand an auditor. Produced from the trail continuously rather than
 * assembled by a person over a week, and every number in it is about the
 * organization's own behaviour rather than about this product.
 */
export function registerEvidenceCommand(program: Command, context: CliContext): void {
  const evidence = program
    .command('evidence')
    .description('What you can hand an auditor: the trail, and the controls behind it');

  evidence
    .command('export', { isDefault: true })
    .description('The governance record for a period, from the audit trail')
    .option('--from <iso-date>', 'period start (ISO 8601)')
    .option('--to <iso-date>', 'period end (ISO 8601)')
    .option('--format <format>', `${FORMAT_MARKDOWN}|${FORMAT_JSON}`, FORMAT_MARKDOWN)
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(
      async (options: {
        from?: string;
        to?: string;
        format: string;
        url?: string;
        adminToken?: string;
      }) => {
        const { client } = await context.connect(options);
        const report: ComplianceReport = await client.complianceReport({
          from: options.from,
          to: options.to,
        });
        context.out.line(
          options.format === FORMAT_JSON
            ? JSON.stringify(report, null, 2)
            : renderComplianceReportMarkdown(report),
        );
      },
    );

  evidence
    .command('controls')
    .description('Every mapped control, its status, and its evidence')
    .option('--framework <name>', `one of: ${FRAMEWORKS.join(', ')}`)
    .option('--gaps', 'show only what is missing')
    .action((options: { framework?: string; gaps?: boolean }) => {
      const frameworks = selected(options.framework);
      for (const line of DISCLAIMER) context.out.line(line);
      context.out.line('');

      for (const framework of frameworks) {
        const summary = readinessFor(framework);
        context.out.line(
          `${FRAMEWORK_LABEL[framework]} \u2014 ${summary.implemented} implemented, ` +
            `${summary.partial} partial, ${summary.planned} not built, ` +
            `${summary.organizational} organizational`,
        );
        for (const control of visible(controlsFor(framework), options.gaps === true)) {
          context.out.line(
            `  ${control.reference.padEnd(24)} ${STATUS_LABEL[control.status]}`,
          );
          context.out.line(`      ${control.requirement}`);
          if (control.gap !== undefined) context.out.line(`      gap: ${control.gap}`);
          for (const each of control.evidence) {
            context.out.line(`      evidence: ${each}`);
          }
        }
        context.out.line('');
      }
    });

  evidence
    .command('summary')
    .description('One line per framework \u2014 what is ready and what is not')
    .action(() => {
      for (const line of DISCLAIMER) context.out.line(line);
      context.out.line('');
      for (const framework of FRAMEWORKS) {
        const summary = readinessFor(framework);
        const total = controlsFor(framework).length;
        context.out.line(
          `${FRAMEWORK_LABEL[framework].padEnd(16)} ${summary.implemented}/${total} implemented, ` +
            `${summary.partial} partial, ${summary.planned} not built`,
        );
      }
      context.out.line('');
      context.out.line(
        `${CONTROL_MAPPINGS.length} controls mapped. Run "memnox evidence controls --gaps" for the work left.`,
      );
    });
}

function selected(name: string | undefined): Framework[] {
  if (name === undefined) return FRAMEWORKS;
  const match = FRAMEWORKS.find((framework) => framework === name);
  if (match === undefined) {
    throw new Error(`--framework must be one of: ${FRAMEWORKS.join(', ')}`);
  }
  return [match];
}

function visible(
  controls: readonly ControlMapping[],
  gapsOnly: boolean,
): readonly ControlMapping[] {
  if (!gapsOnly) return controls;
  return controls.filter((control) => control.status !== CONTROL_STATUS.IMPLEMENTED);
}
