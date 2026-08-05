import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import type { CliOutput } from '../cli-output';
import { stringify } from 'yaml';
import type { DecisionEffect } from '@memnox/core';
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
import { loadPoliciesFromFile } from '@memnox/local-gate';
import { DEFAULT_BASE_URL, DEFAULT_POLICY_FILE } from '../defaults';
import { casesFromAudit } from '../simulation-cases';
import { registerPolicyUiCommand } from './policy-ui.command';

const DEFAULT_SIMULATION_SAMPLE = 500;
const MAX_LISTED_CHANGES = 20;

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

  interface SimulateOptions {
    file?: string;
    against?: string;
    url?: string;
    adminToken?: string;
    limit: string;
    defaultEffect: string;
  }

  const runSimulation = async (
    candidateFile: string | undefined,
    options: SimulateOptions,
  ): Promise<void> => {
    const candidate = candidateFile ?? options.file;
    if (candidate === undefined) {
      throw new Error('Which file? Try:  memnox simulate candidate.yaml');
    }

    const { client } = await context.connect(options);
    const cases = casesFromAudit(await client.recentAudit(Number(options.limit)));
    if (cases.length === 0) {
      context.out.line('No audit history yet — nothing to simulate against.');
      context.out.note('');
      context.out.note('→ Let it observe first:  memnox setup, then use your editor.');
      return;
    }

    const defaultEffect = options.defaultEffect as DecisionEffect;
    const candidatePolicies = await loadPoliciesFromFile(candidate);
    // The rules in force are what you are comparing against; asking for them
    // every time was a flag that only ever had one useful value.
    const baseline = options.against ?? DEFAULT_POLICY_FILE;
    const baselinePolicies = existsSync(baseline)
      ? await loadPoliciesFromFile(baseline)
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
  };

  const simulateFlags = (command: Command): Command =>
    command
      .option('-f, --file <path>', 'candidate policy file')
      .option(
        '--against <path>',
        `baseline policy file (default: ${DEFAULT_POLICY_FILE})`,
      )
      .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
      .option('--admin-token <token>', 'admin token for reading audit history')
      .option('--limit <n>', 'audit events to replay', String(DEFAULT_SIMULATION_SAMPLE))
      .option(
        '--default-effect <effect>',
        'effect when no policy matches',
        DECISION_EFFECT.ALLOW,
      );

  simulateFlags(
    policy
      .command('simulate [file]')
      .description('Show what a candidate policy set would decide differently'),
  ).action(async (file: string | undefined, options: SimulateOptions) =>
    runSimulation(file, options),
  );

  // Top-level alias: this is the step that makes a policy change safe to ship,
  // so it should not be three words deep.
  simulateFlags(
    program
      .command('simulate [file]')
      .description('Replay real history through candidate rules before shipping them'),
  ).action(async (file: string | undefined, options: SimulateOptions) =>
    runSimulation(file, options),
  );

  program
    .command('reload')
    .description('Re-read the policy files without restarting the runtime')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(async (options: { url?: string; adminToken?: string }) => {
      const { client } = await context.connect(options);
      const result = await client.reloadPolicies();
      context.out.line(`Policies reloaded — version ${result.version}`);
    });

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

  registerPolicyUiCommand(policy, context);
  // Top-level as well: "I would rather not write YAML" is the reason someone
  // reaches for this, and that answer should not be three words deep.
  registerPolicyUiCommand(program, context);
}
