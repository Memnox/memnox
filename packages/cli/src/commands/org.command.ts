import { randomUUID } from 'node:crypto';
import type { Command } from 'commander';
import {
  OrganizationExtractor,
  SlackSource,
  type MessageSource,
} from '@memnox/intelligence';
import { STATED_KIND, type Stated } from '@memnox/org-graph';
import type { CliContext } from '../cli-context';
import { DEFAULT_BASE_URL } from '../defaults';
import {
  buildLlmProvider,
  PROVIDER_CHOICES,
  type LlmProviderFactory,
} from '../llm-provider-option';

const KIND_CHOICES = Object.values(STATED_KIND).join('|');

/** Builds the source a run reads from. A defaulted parameter, so a test swaps it. */
export type MessageSourceFactory = (source: string, token: string) => MessageSource;

export const buildMessageSource: MessageSourceFactory = (source, token) => {
  if (source !== 'slack') {
    throw new Error(`unknown source "${source}" — only "slack" is supported`);
  }
  return new SlackSource({ token });
};

/**
 * What the organization states about itself, and who has delegated what.
 *
 * `import` is the one command here that costs money and calls a model, and it
 * is deliberately the one that decides nothing: everything it writes lands as a
 * candidate for a person to confirm. The two planes of the product are visible
 * in this file — an expensive offline read, and a free deterministic one.
 */
export function registerOrgCommand(
  program: Command,
  context: CliContext,
  buildProvider: LlmProviderFactory = buildLlmProvider,
  buildSource: MessageSourceFactory = buildMessageSource,
): void {
  const org = program
    .command('org')
    .description('What your organization states about itself, and who may act for whom');

  org
    .command('import')
    .description(
      'Read a channel and file what it states as candidates for review (BYOK LLM; nothing it writes enforces)',
    )
    .requiredOption('--channel <id>', 'channel to read, e.g. C0123456789')
    .option('--source <name>', 'slack', 'slack')
    .option('--since <iso-date>', 'only read messages after this time')
    .option('--source-token <token>', 'source API token; falls back to SLACK_TOKEN')
    .option('--provider <provider>', PROVIDER_CHOICES.join('|'), PROVIDER_CHOICES[0])
    .option('--model <model>', 'override the provider default model')
    .option('--workspace <name>', 'workspace to file the candidates under')
    .option('--dry-run', 'print what was read without filing anything')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(
      async (options: {
        channel: string;
        source: string;
        since?: string;
        sourceToken?: string;
        provider: string;
        model?: string;
        workspace?: string;
        dryRun?: boolean;
        url?: string;
        adminToken?: string;
      }) => {
        const token = options.sourceToken ?? process.env['SLACK_TOKEN'];
        if (token === undefined || token.length === 0) {
          context.out.note('No source token — pass --source-token or set SLACK_TOKEN.');
          return;
        }

        const source = buildSource(options.source, token);
        const messages = await source.read(options.channel, options.since);
        if (messages.length === 0) {
          context.out.note(`No readable messages in ${options.channel}.`);
          return;
        }

        const extractor = new OrganizationExtractor(
          buildProvider(options.provider, options.model),
        );
        const candidates = await extractor.extract({
          workspaceId: options.workspace ?? 'default',
          messages,
          newId: randomUUID,
          detectedAt: new Date().toISOString(),
        });

        context.out.note(
          `Read ${messages.length} message(s) from ${source.name}, found ${candidates.length} candidate statement(s).`,
        );
        for (const candidate of candidates) describe(context, candidate);
        if (candidates.length === 0) return;

        if (options.dryRun === true) {
          context.out.note('Dry run — nothing was filed.');
          return;
        }

        const { client } = await context.connect(options);
        const filed = await client.proposeStatements(candidates, options.workspace);
        const alreadyHeld =
          filed.duplicates === 0
            ? ''
            : ` ${filed.duplicates} were already on file and were not filed again.`;
        context.out.note(
          `Filed ${filed.stored} candidate(s).${alreadyHeld} None of them enforce anything until you run "memnox org verify <id>".`,
        );
      },
    );

  org
    .command('list')
    .description('Everything the organization states, candidates included')
    .option('--workspace <name>', 'workspace to read')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(
      async (options: { workspace?: string; url?: string; adminToken?: string }) => {
        const { client } = await context.connect(options);
        const statements = await client.listStatements(options.workspace);
        if (statements.length === 0) {
          context.out.note('The organization states nothing yet.');
          return;
        }
        for (const stated of statements) {
          context.out.line(
            `${stated.status.padEnd(10)} ${stated.kind.padEnd(15)} ${stated.id}`,
          );
          context.out.line(`           ${stated.statement}`);
        }
      },
    );

  org
    .command('verify <id>')
    .description('Confirm a candidate. Only after this does it bind anything')
    .option('--by <who>', 'who is confirming it')
    .option('--workspace <name>', 'workspace the statement belongs to')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(
      async (
        id: string,
        options: {
          by?: string;
          workspace?: string;
          url?: string;
          adminToken?: string;
        },
      ) => {
        const { client } = await context.connect(options);
        const verified = await client.verifyStatement(id, options.by, options.workspace);
        context.out.note(`Verified: ${verified.statement}`);
      },
    );

  org
    .command('reject <id>')
    .description('Refuse a candidate. Kept as history, never deleted')
    .option('--by <who>', 'who is refusing it')
    .option('--workspace <name>', 'workspace the statement belongs to')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(
      async (
        id: string,
        options: {
          by?: string;
          workspace?: string;
          url?: string;
          adminToken?: string;
        },
      ) => {
        const { client } = await context.connect(options);
        await client.rejectStatement(id, options.by, options.workspace);
        context.out.note(`Rejected ${id}.`);
      },
    );

  org
    .command('state')
    .description('Record a statement yourself. Binds immediately — a person said it')
    .requiredOption('--kind <kind>', KIND_CHOICES)
    .requiredOption('--statement <text>', "the claim in the company's own words")
    .requiredOption('--subject <subject>', 'what it is about')
    .option('--principal <who>', 'the person an authority grants something to')
    .option('--capability <patterns>', 'comma-separated action patterns, on an authority')
    .option('--limit <amount>', 'ceiling on an authority', Number)
    .option('--object <who>', 'the owner, on a responsibility')
    .option('--clearance <patterns>', 'comma-separated principals cleared to read it')
    .option('--source-ref <url>', 'permalink to the evidence')
    .option('--by <who>', 'who is recording it')
    .option('--workspace <name>', 'workspace to record it in')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(
      async (options: {
        kind: string;
        statement: string;
        subject: string;
        principal?: string;
        capability?: string;
        limit?: number;
        object?: string;
        clearance?: string;
        sourceRef?: string;
        by?: string;
        workspace?: string;
        url?: string;
        adminToken?: string;
      }) => {
        const { client } = await context.connect(options);
        const recorded = await client.recordStatement(
          {
            kind: options.kind as 'decision',
            statement: options.statement,
            subject: options.subject,
            ...(options.principal === undefined ? {} : { principal: options.principal }),
            ...(options.capability === undefined
              ? {}
              : { capability: options.capability }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
            ...(options.object === undefined ? {} : { object: options.object }),
            ...(options.clearance === undefined
              ? {}
              : { clearance: splitList(options.clearance) }),
            ...(options.sourceRef === undefined ? {} : { sourceRef: options.sourceRef }),
            ...(options.by === undefined ? {} : { recordedBy: options.by }),
          },
          options.workspace,
        );
        context.out.note(`Recorded ${recorded.id}.`);
      },
    );

  org
    .command('delegate')
    .description('Record what one person has delegated to the agents acting for them')
    .requiredOption('--principal <who>', 'the person whose authority this draws on')
    .requiredOption('--actions <patterns>', 'comma-separated action patterns')
    .option('--agents <names>', 'comma-separated agent names; default is every agent')
    .option('--limit <amount>', 'the largest amount an agent may act on alone', Number)
    .option('--over-limit <effect>', 'require_approval|block', 'require_approval')
    .option('--approvers <who>', 'comma-separated approvers past the ceiling')
    .option('--expires <iso-date>', 'when the delegation stops applying')
    .option('--by <who>', 'who granted it')
    .option('--workspace <name>', 'workspace to record it in')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(
      async (options: {
        principal: string;
        actions: string;
        agents?: string;
        limit?: number;
        overLimit: string;
        approvers?: string;
        expires?: string;
        by?: string;
        workspace?: string;
        url?: string;
        adminToken?: string;
      }) => {
        const { client } = await context.connect(options);
        const grant = await client.delegateAuthority(
          {
            principal: options.principal,
            actions: splitList(options.actions),
            ...(options.agents === undefined
              ? {}
              : { agents: splitList(options.agents) }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
            ...(options.overLimit === 'block' ? { overLimit: 'block' as const } : {}),
            ...(options.approvers === undefined
              ? {}
              : { approvers: splitList(options.approvers) }),
            ...(options.expires === undefined ? {} : { expiresAt: options.expires }),
            ...(options.by === undefined ? {} : { grantedBy: options.by }),
          },
          options.workspace,
        );
        context.out.note(
          `${grant.principal} has delegated ${grant.actions.join(', ')}${
            grant.limit === undefined ? '' : ` up to ${grant.limit}`
          }.`,
        );
      },
    );

  org
    .command('authority')
    .description('What each person has delegated, and to which agents')
    .option('--workspace <name>', 'workspace to read')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(
      async (options: { workspace?: string; url?: string; adminToken?: string }) => {
        const { client } = await context.connect(options);
        const grants = await client.listAuthority(options.workspace);
        if (grants.length === 0) {
          context.out.note('Nobody has delegated anything yet.');
          return;
        }
        for (const grant of grants) {
          const ceiling =
            grant.limit === undefined ? 'no ceiling' : `up to ${grant.limit}`;
          context.out.line(
            `${grant.principal} → ${grant.actions.join(', ')} (${ceiling}) ${grant.id}`,
          );
        }
      },
    );
}

function describe(context: CliContext, candidate: Stated): void {
  context.out.line(`  ${candidate.kind}: ${candidate.statement}`);
  context.out.line(
    `    subject=${candidate.subject} confidence=${candidate.confidence} id=${candidate.id}`,
  );
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
