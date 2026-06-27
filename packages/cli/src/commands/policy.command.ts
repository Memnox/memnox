import { readFile, writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import type { CliOutput } from '../cli-output';
import { stringify } from 'yaml';
import type { ActionEvent, DecisionEffect } from '@memnox/core';
import { DECISION_EFFECT } from '@memnox/core';
import {
  comparePolicySets,
  findPolicyPack,
  mergePolicies,
  POLICY_DOCUMENT_VERSION,
  POLICY_PACKS,
  PolicyEngine,
  versionPolicySet,
  type Policy,
  type SimulationCase,
} from '@memnox/policy-engine';
import { loadPoliciesFromFile } from '@memnox/runtime';
import { DEFAULT_BASE_URL, DEFAULT_POLICY_FILE } from '../defaults';

const DEFAULT_SIMULATION_SAMPLE = 500;
const MAX_LISTED_CHANGES = 20;

/** Real actions make a far better test set than invented ones. */
function casesFromAudit(events: readonly ActionEvent[]): SimulationCase[] {
  return events.map((event) => ({
    action: event.action,
    ...(event.target ? { target: event.target } : {}),
    ...(event.environment ? { environment: event.environment } : {}),
    agentName: event.agentName,
  }));
}

const describeCase = (item: SimulationCase): string =>
  [item.action, item.target, item.environment].filter(Boolean).join(' ');

function reportComparison(
  out: CliOutput,
  changes: ReturnType<typeof comparePolicySets>,
  candidateVersion: string,
): void {
  out.line(`Candidate policy version: ${candidateVersion}`);
  out.line(`Cases evaluated : ${changes.total}`);
  out.line(`Unchanged       : ${changes.unchanged}`);
  out.line(`Changed         : ${changes.changes.length}`);
  out.line(
    `Candidate totals: allow ${changes.candidateTotals[DECISION_EFFECT.ALLOW]}, ` +
      `approval ${changes.candidateTotals[DECISION_EFFECT.REQUIRE_APPROVAL]}, ` +
      `block ${changes.candidateTotals[DECISION_EFFECT.BLOCK]}`,
  );

  if (changes.changes.length === 0) {
    out.line('\nNo action would be decided differently.');
    return;
  }

  out.line('');
  for (const change of changes.changes.slice(0, MAX_LISTED_CHANGES)) {
    const direction = change.stricter ? 'STRICTER' : 'LOOSER  ';
    out.line(
      `  ${direction}  ${change.before} → ${change.after}  ${describeCase(change.case)}` +
        (change.matchedPolicies.length > 0
          ? `  [${change.matchedPolicies.join(', ')}]`
          : ''),
    );
  }
  const remaining = changes.changes.length - MAX_LISTED_CHANGES;
  if (remaining > 0) out.line(`  … and ${remaining} more`);

  const looser = changes.changes.filter((change) => !change.stricter).length;
  if (looser > 0) {
    out.line(
      `\nWarning: ${looser} action(s) become MORE permissive under the candidate set.`,
    );
  }
}

async function writePolicyFile(filePath: string, policies: Policy[]): Promise<void> {
  await writeFile(
    filePath,
    stringify({ version: POLICY_DOCUMENT_VERSION, policies }),
    'utf8',
  );
}

export function registerPolicyCommand(program: Command, context: CliContext): void {
  const policy = program
    .command('policy')
    .description('Inspect, version, simulate, and compose policy sets');

  policy
    .command('version')
    .description('Print the content version of a policy set')
    .option('-f, --file <path>', 'policy file', DEFAULT_POLICY_FILE)
    .action(async (options: { file: string }) => {
      const summary = versionPolicySet(await loadPoliciesFromFile(options.file));
      context.out.line(`Version : ${summary.version}`);
      context.out.line(`Policies: ${summary.policyCount}`);
      for (const name of summary.policyNames) context.out.line(`  - ${name}`);
    });

  policy
    .command('simulate')
    .description('Show what a candidate policy set would decide differently')
    .requiredOption('-f, --file <path>', 'candidate policy file')
    .option('--against <path>', 'baseline policy file (default: no policies)')
    .option('--from-audit', 'draw cases from the running runtime audit history')
    .option('--url <url>', 'runtime base URL', DEFAULT_BASE_URL)
    .option('--admin-token <token>', 'admin token for reading audit history')
    .option('--limit <n>', 'audit events to replay', String(DEFAULT_SIMULATION_SAMPLE))
    .option(
      '--default-effect <effect>',
      'effect when no policy matches',
      DECISION_EFFECT.ALLOW,
    )
    .action(
      async (options: {
        file: string;
        against?: string;
        fromAudit?: boolean;
        url: string;
        adminToken?: string;
        limit: string;
        defaultEffect: string;
      }) => {
        if (!options.fromAudit) {
          throw new Error(
            '--from-audit is required: simulating against real history is the point',
          );
        }
        const cases = casesFromAudit(
          await context.client(options).recentAudit(Number(options.limit)),
        );
        if (cases.length === 0) {
          context.out.line('No audit history yet — nothing to simulate against.');
          return;
        }

        const defaultEffect = options.defaultEffect as DecisionEffect;
        const candidatePolicies = await loadPoliciesFromFile(options.file);
        const baselinePolicies = options.against
          ? await loadPoliciesFromFile(options.against)
          : [];

        reportComparison(
          context.out,
          comparePolicySets(
            new PolicyEngine(baselinePolicies, { defaultEffect }),
            new PolicyEngine(candidatePolicies, { defaultEffect }),
            cases,
          ),
          versionPolicySet(candidatePolicies).version,
        );
      },
    );

  policy
    .command('packs')
    .description('List the policy packs available to install')
    .action(() => {
      for (const pack of POLICY_PACKS) {
        context.out.line(`${pack.name}  (${pack.policies.length} policies)`);
        context.out.line(`  ${pack.description}`);
      }
      context.out.line('\nInstall one with: memnox policy install <pack>');
    });

  policy
    .command('install <pack>')
    .description('Append a policy pack to your policy file')
    .option('-f, --file <path>', 'policy file', DEFAULT_POLICY_FILE)
    .option('--dry-run', 'show what would be added without writing')
    .action(async (packName: string, options: { file: string; dryRun?: boolean }) => {
      const pack = findPolicyPack(packName);
      if (!pack) {
        throw new Error(
          `unknown pack "${packName}" — run "memnox policy packs" to list them`,
        );
      }

      const existing = await loadPoliciesFromFile(options.file).catch(
        () => [] as Policy[],
      );
      const merged = mergePolicies(existing, pack.policies);

      for (const name of merged.added) context.out.line(`  + ${name}`);
      for (const name of merged.skipped)
        context.out.line(`  = ${name} (already defined)`);

      if (options.dryRun) {
        context.out.line('\nDry run — nothing written.');
        return;
      }
      if (merged.added.length === 0) {
        context.out.line('\nNothing to add.');
        return;
      }
      await writePolicyFile(options.file, merged.policies);
      context.out.line(
        `\nAdded ${merged.added.length} policies to ${options.file} (version ${versionPolicySet(merged.policies).version})`,
      );
    });
}
