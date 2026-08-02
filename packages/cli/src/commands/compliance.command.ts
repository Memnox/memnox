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
import type { CliContext } from '../cli-context';

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

export function registerComplianceCommand(program: Command, context: CliContext): void {
  const compliance = program
    .command('compliance')
    .description('Control readiness against SOC 2, ISO 27001, HIPAA, and GDPR');

  compliance
    .command('controls', { isDefault: true })
    .description('List every mapped control, its status, and its evidence')
    .option('--framework <name>', `one of: ${FRAMEWORKS.join(', ')}`)
    .option('--gaps', 'show only what is missing')
    .action((options: { framework?: string; gaps?: boolean }) => {
      const frameworks = selected(options.framework);
      for (const line of DISCLAIMER) context.out.line(line);
      context.out.line('');

      for (const framework of frameworks) {
        const summary = readinessFor(framework);
        context.out.line(
          `${FRAMEWORK_LABEL[framework]} — ${summary.implemented} implemented, ` +
            `${summary.partial} partial, ${summary.planned} not built, ` +
            `${summary.organizational} organizational`,
        );
        for (const control of visible(controlsFor(framework), options.gaps === true)) {
          context.out.line(
            `  ${control.reference.padEnd(24)} ${STATUS_LABEL[control.status]}`,
          );
          context.out.line(`      ${control.requirement}`);
          if (control.gap !== undefined) context.out.line(`      gap: ${control.gap}`);
          for (const evidence of control.evidence) {
            context.out.line(`      evidence: ${evidence}`);
          }
        }
        context.out.line('');
      }
    });

  compliance
    .command('summary')
    .description('One line per framework — what is ready and what is not')
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
        `${CONTROL_MAPPINGS.length} controls mapped. Run "memnox compliance controls --gaps" for the work left.`,
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
