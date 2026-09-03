import type { Command } from 'commander';
import {
  PRODUCTION_HINTS,
  RESOURCE_KIND,
  type DiscoveryReport,
  type Resource,
} from '@memnox/discovery';
import type { CliContext } from '../cli-context';
import { defaultScanSeams, scanMachine, type ScanSeams } from '../machine-scan';

const NAME_WIDTH = 16;

/**
 * A class of resource somebody actually asks about, resolved through what each agent
 * can reach rather than through what it was labelled.
 */
const RESOURCE_CLASSES: Readonly<Record<string, (resource: Resource) => boolean>> = {
  production: (resource) => named(resource, PRODUCTION_HINTS),
  'customer-data': (resource) => resource.kind === RESOURCE_KIND.DB,
  credentials: (resource) => resource.kind === RESOURCE_KIND.SECRET,
  repositories: (resource) => resource.kind === RESOURCE_KIND.REPO,
  network: (resource) => resource.kind === RESOURCE_KIND.NETWORK,
};

function named(resource: Resource, hints: readonly string[]): boolean {
  const text = `${resource.id} ${resource.path ?? ''} ${resource.declaredIn ?? ''}`;
  return hints.some((hint) => text.toLowerCase().includes(hint));
}

/**
 * Blast radius, on demand, answered from reachability rather than from a spreadsheet
 * somebody maintains.
 *
 * Limit: this machine. Every row here is something proved on this disk, and the same
 * question across a fleet needs somebody else's machines, which is the cloud.
 */
export function registerWhoCommand(
  program: Command,
  context: CliContext,
  buildSeams: (cwd: string) => ScanSeams = defaultScanSeams,
  cwd: () => string = () => process.cwd(),
): void {
  program
    .command('who')
    .description('Which agents on this machine reach a class of resource')
    .requiredOption(
      '--resource <class>',
      `one of: ${Object.keys(RESOURCE_CLASSES).join(', ')}`,
    )
    .option('--json', 'emit the answer as JSON')
    .option(
      '--no-probe',
      'do not start MCP servers to ask what they hold; tools go uncounted',
    )
    .action(async (options: { resource: string; json?: boolean; probe: boolean }) => {
      const matches = RESOURCE_CLASSES[options.resource];
      if (matches === undefined) {
        throw new Error(
          `unknown resource class "${options.resource}" — one of: ${Object.keys(RESOURCE_CLASSES).join(', ')}`,
        );
      }

      const seams = buildSeams(cwd());
      const { report } = await scanMachine(seams, { probe: options.probe });
      const answer = reachOf(report, matches);

      if (options.json === true) {
        context.out.line(
          JSON.stringify({ resource: options.resource, agents: answer }, null, 2),
        );
        return;
      }
      render(context, options.resource, answer);
    });
}

interface Reach {
  agentId: string;
  kind: string;
  /** What proved it. A row that cannot be checked is an assurance, not an answer. */
  evidence: string[];
}

function reachOf(
  report: DiscoveryReport,
  matches: (resource: Resource) => boolean,
): Reach[] {
  const wanted = report.resources.filter(matches);
  return report.agents.map((agent) => ({
    agentId: agent.id,
    kind: agent.kind,
    evidence: wanted
      .filter((resource) => resource.reachableBy.some((ref) => ref.id === agent.id))
      .map((resource) => resource.path ?? resource.declaredIn ?? resource.id),
  }));
}

function render(context: CliContext, resource: string, answer: readonly Reach[]): void {
  const { out, style } = context;
  out.line('');
  out.line(style.bold(`WHO REACHES ${resource.toUpperCase()}`));
  out.line('');

  if (answer.length === 0) {
    out.line('  No agent was found on this machine.');
    out.line('');
    return;
  }

  for (const row of answer) {
    const reaches = row.evidence.length > 0;
    const mark = reaches ? style.warn('✓') : '✕';
    out.line(`  ${mark}  ${row.kind.padEnd(NAME_WIDTH)}${reaches ? '' : 'no'}`);
    for (const evidence of row.evidence) {
      out.line(`     ${style.dim(evidence)}`);
    }
  }

  const reaching = answer.filter((row) => row.evidence.length > 0).length;
  out.line('');
  out.line(
    style.dim(
      `${reaching} of ${answer.length} agent(s) here reach it. This machine only — ` +
        'the same question across a fleet needs machines this one cannot see.',
    ),
  );
  out.line('');
}
