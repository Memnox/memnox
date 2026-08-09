import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import {
  DECISION_ENFORCEMENT,
  DECISION_SOURCE_MANUAL,
  DECISION_STATUS,
  REVERSIBILITY_COST,
} from '@memnox/memory';
import { DEFAULT_BASE_URL } from '../defaults';

const VALID_ENFORCEMENTS = Object.values(DECISION_ENFORCEMENT).join('|');

export function registerMemoryCommand(program: Command, context: CliContext): void {
  const memory = program
    .command('memory')
    .description('Team decisions that constrain AI actions');

  memory
    .command('add')
    .description('Record a team decision as a machine-checkable constraint')
    .requiredOption('--title <title>', 'short decision title')
    .requiredOption('--statement <text>', 'the decision in your own words')
    .requiredOption('--owner <owner>', 'who made the decision')
    .requiredOption(
      '--actions <patterns>',
      'comma-separated action patterns, e.g. database.migrate',
    )
    .option('--targets <patterns>', 'comma-separated target patterns')
    .option('--envs <patterns>', 'comma-separated environment patterns')
    .option(
      '--enforcement <effect>',
      VALID_ENFORCEMENTS,
      DECISION_ENFORCEMENT.REQUIRE_APPROVAL,
    )
    .option(
      '--review-after <iso-date>',
      'flag the decision as due for review after this date',
    )
    .option('--reversibility <cost>', `${Object.values(REVERSIBILITY_COST).join('|')}`)
    .option(
      '--source <sourceType>',
      'where the decision came from',
      DECISION_SOURCE_MANUAL,
    )
    .option('--supersedes <id>', 'existing decision this one replaces')
    .option('--source-ref <url>', 'permalink to the evidence (Slack thread, PR, doc)')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(
      async (options: {
        title: string;
        statement: string;
        owner: string;
        actions: string;
        targets?: string;
        envs?: string;
        enforcement: string;
        reviewAfter?: string;
        reversibility?: string;
        source: string;
        sourceRef?: string;
        supersedes?: string;
        url?: string;
        adminToken?: string;
      }) => {
        const { client } = await context.connect(options);
        const record = await client.addDecision({
          title: options.title,
          statement: options.statement,
          owner: options.owner,
          actions: splitPatterns(options.actions),
          targets: options.targets ? splitPatterns(options.targets) : undefined,
          environments: options.envs ? splitPatterns(options.envs) : undefined,
          enforcement: options.enforcement,
          reviewAfter: options.reviewAfter,
          reversibilityCost: options.reversibility,
          sourceType: options.source,
          sourceRef: options.sourceRef,
          supersedes: options.supersedes,
        });
        context.out.line(
          `Decision recorded: ${record.title} (${record.id}) → ${record.enforcement}`,
        );
      },
    );

  memory
    .command('list')
    .description('List recorded decisions')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(async (options: { url?: string; adminToken?: string }) => {
      const { client } = await context.connect(options);
      const decisions = await client.listDecisions();
      if (decisions.length === 0) {
        context.out.line('No decisions recorded. Add one with "memnox memory add".');
        return;
      }
      for (const decision of decisions) {
        const status = decision.status ?? DECISION_STATUS.ACTIVE;
        const superseded = decision.supersededById ? ` → ${decision.supersededById}` : '';
        context.out.line(
          `${decision.id}  [${status}${superseded}] [${decision.enforcement}] ${decision.title} (${decision.owner}) — actions: ${decision.actions.join(', ')}`,
        );
      }
    });

  memory
    .command('health')
    .description('Decision-corpus health: stale, frequently-violated, never-referenced')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(async (options: { url?: string; adminToken?: string }) => {
      const { client } = await context.connect(options);
      const health = await client.decisionHealth();
      context.out.line(`Health score      : ${health.score}/100`);
      context.out.line(`Active decisions  : ${health.activeDecisions}`);
      context.out.line(`Stale             : ${health.stale}`);
      context.out.line(`Frequently broken : ${health.frequentlyViolated}`);
      context.out.line(`Never referenced  : ${health.neverReferenced}`);
      for (const entry of health.entries) {
        const flags = [
          entry.stale ? 'stale' : null,
          entry.dueForReview ? 'review-due' : null,
          entry.neverReferenced ? 'never-referenced' : null,
        ]
          .filter(Boolean)
          .join(', ');
        context.out.line(
          `  - ${entry.title}: ${entry.violations} enforcement hit(s)${flags ? ` [${flags}]` : ''}`,
        );
      }
    });

  memory
    .command('digest')
    .description(
      'Prompt-injectable digest of the active constraints for agent preloading',
    )
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(async (options: { url?: string; adminToken?: string }) => {
      const { client } = await context.connect(options);
      context.out.line(await client.decisionDigest());
    });

  memory
    .command('retire <id>')
    .description('Retire a decision — it stops enforcing but stays in history')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(async (id: string, options: { url?: string; adminToken?: string }) => {
      const { client } = await context.connect(options);
      const decision = await client.setDecisionStatus(id, DECISION_STATUS.RETIRED);
      context.out.line(`Decision "${decision.title}" is now ${decision.status}.`);
    });

  memory
    .command('remove <id>')
    .description('Delete a recorded decision')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(async (id: string, options: { url?: string; adminToken?: string }) => {
      const { client } = await context.connect(options);
      await client.removeDecision(id);
      context.out.line(`Decision ${id} removed.`);
    });
}

function splitPatterns(value: string): string[] {
  return value
    .split(',')
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0);
}
