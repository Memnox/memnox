import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { parseEnforcement } from '../enforcement-args';
import { DECISION_EFFECT, type DecisionEffect } from '@memnox/core';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  startServer,
  type MemnoxServer,
  type RuntimeConfig,
} from '@memnox/runtime';

/** How `serve` brings the runtime up. Injected so tests reach the config mapping and the banner. */
export type ServerLauncher = (
  overrides: Partial<RuntimeConfig>,
) => Promise<Pick<MemnoxServer, 'config'>>;

const VALID_DEFAULT_EFFECTS: readonly string[] = [
  DECISION_EFFECT.ALLOW,
  DECISION_EFFECT.BLOCK,
];

/** Container deployments configure secrets via environment; flags win when both are set. */
const ENV_ADMIN_TOKEN = 'MEMNOX_ADMIN_TOKEN';
const ENV_DATABASE_URL = 'MEMNOX_DATABASE_URL';
const ENV_REDIS_URL = 'MEMNOX_REDIS_URL';
const ENV_DATA_KEY = 'MEMNOX_DATA_KEY';
const ENV_TLS_CERT = 'MEMNOX_TLS_CERT';
const ENV_TLS_KEY = 'MEMNOX_TLS_KEY';
const ENV_TLS_CA = 'MEMNOX_TLS_CA';
const ENV_EMBEDDING_KEY = 'MEMNOX_EMBEDDING_KEY';

const envOr = (value: string | undefined, name: string): string | undefined =>
  value ?? (process.env[name] || undefined);

export function registerServeCommand(
  program: Command,
  context: CliContext,
  launch: ServerLauncher = startServer,
): void {
  program
    .command('serve')
    .description('Start the Memnox runtime gateway')
    .option('-p, --port <port>', 'port to listen on', String(DEFAULT_PORT))
    .option('-H, --host <host>', 'host to bind', DEFAULT_HOST)
    .option('--policies <path>', 'YAML policy file')
    .option('--data-dir <path>', 'local data directory')
    .option('--admin-token <token>', 'require this bearer token on admin routes')
    .option('--behavior-guard', 'enable the deterministic behavioral advisor')
    .option('--trust-guard', 'require approval for risky actions from low-trust agents')
    .option(
      '--tls-cert <path>',
      'TLS server certificate (enables mTLS with --tls-key/--tls-ca)',
    )
    .option('--tls-key <path>', 'TLS server private key')
    .option('--tls-ca <path>', 'CA bundle used to verify client certificates')
    .option('--no-content-shield', 'disable secret/PII scanning of written content')
    .option('--no-shell-guard', 'disable reading past shell indirection')
    .option('--token-budget <tokens>', 'cap cumulative llm.spend tokens per session')
    .option('--slack-signing-secret <secret>', 'enable Slack interactive approvals')
    .option('--data-key <key>', 'encrypt local stores at rest with this key')
    .option(
      '--agent-jwt-secret <secret>',
      'accept HS256 agent JWTs signed with this value',
    )
    .option('--agent-jwt-issuer <issuer>', 'required issuer for agent JWTs')
    .option(
      '--database-url <url>',
      'Postgres connection string (default: local file stores)',
    )
    .option(
      '--redis-url <url>',
      'Redis connection string — shares rate limits and locks across pods',
    )
    .option(
      '--rate-limit <rpm>',
      'per-agent requests/minute on the check endpoint (0 disables)',
    )
    .option(
      '--audit-retention-days <days>',
      'prune audit events older than this many days (0 disables)',
    )
    .option('--no-memory', 'disable decision-memory enforcement')
    .option(
      '--dependency-guard',
      'govern dependency.add: vulnerable versions and licenses',
    )
    .option(
      '--dependency-license-lookup',
      'let the dependency guard read licenses from the npm registry',
    )
    .option(
      '--embedding-key <key>',
      'BYOK embedding key — enables hybrid keyword + semantic decision search',
    )
    .option(
      '--embedding-model <model>',
      'embedding model (default: text-embedding-3-small)',
    )
    .option(
      '--embedding-dimensions <n>',
      'embedding width; must match the model (default: 1536)',
    )
    .option('--code-graph <path>', 'code-graph snapshot from "memnox graph build"')
    .option(
      '--protected-path <pattern>',
      'require approval for changes reaching this path (repeatable)',
      (pattern: string, previous: string[]) => [...previous, pattern],
      [] as string[],
    )
    .option(
      '--approval-webhook <url>',
      'Slack-compatible webhook notified on new approvals',
    )
    .option(
      '--default-effect <effect>',
      `effect when no policy matches (${VALID_DEFAULT_EFFECTS.join('|')})`,
      DECISION_EFFECT.ALLOW,
    )
    .option(
      '--enforcement <spec>',
      'per-environment mode, e.g. "default=monitor,production=enforce"',
    )
    .action(
      async (options: {
        port: string;
        host: string;
        policies?: string;
        dataDir?: string;
        adminToken?: string;
        behaviorGuard?: boolean;
        trustGuard?: boolean;
        tlsCert?: string;
        tlsKey?: string;
        tlsCa?: string;
        memory: boolean;
        contentShield: boolean;
        shellGuard: boolean;
        codeGraph?: string;
        protectedPath: string[];
        embeddingKey?: string;
        embeddingModel?: string;
        embeddingDimensions?: string;
        dependencyGuard?: boolean;
        dependencyLicenseLookup?: boolean;
        tokenBudget?: string;
        approvalWebhook?: string;
        slackSigningSecret?: string;
        dataKey?: string;
        agentJwtSecret?: string;
        agentJwtIssuer?: string;
        rateLimit?: string;
        databaseUrl?: string;
        redisUrl?: string;
        auditRetentionDays?: string;
        defaultEffect: string;
        enforcement?: string;
      }) => {
        if (!VALID_DEFAULT_EFFECTS.includes(options.defaultEffect)) {
          throw new Error(
            `--default-effect must be one of: ${VALID_DEFAULT_EFFECTS.join(', ')}`,
          );
        }
        const server = await launch({
          port: Number(options.port),
          host: options.host,
          policyFile: options.policies,
          dataDir: options.dataDir,
          adminToken: envOr(options.adminToken, ENV_ADMIN_TOKEN),
          behaviorGuard: options.behaviorGuard ?? false,
          trustGuard: options.trustGuard ?? false,
          tlsCertFile: envOr(options.tlsCert, ENV_TLS_CERT),
          tlsKeyFile: envOr(options.tlsKey, ENV_TLS_KEY),
          tlsCaFile: envOr(options.tlsCa, ENV_TLS_CA),
          memoryEnabled: options.memory,
          contentShield: options.contentShield,
          shellGuard: options.shellGuard,
          codeGraphFile: options.codeGraph,
          protectedPaths: options.protectedPath,
          embeddingApiKey: envOr(options.embeddingKey, ENV_EMBEDDING_KEY),
          embeddingModel: options.embeddingModel,
          embeddingDimensions: options.embeddingDimensions
            ? Number(options.embeddingDimensions)
            : undefined,
          dependencyGuard: options.dependencyGuard ?? false,
          dependencyLicenseLookup: options.dependencyLicenseLookup ?? false,
          sessionTokenBudget: options.tokenBudget
            ? Number(options.tokenBudget)
            : undefined,
          approvalWebhookUrl: options.approvalWebhook,
          slackSigningSecret: options.slackSigningSecret,
          dataEncryptionKey: envOr(options.dataKey, ENV_DATA_KEY),
          agentJwtSecret: options.agentJwtSecret,
          agentJwtIssuer: options.agentJwtIssuer,
          databaseUrl: envOr(options.databaseUrl, ENV_DATABASE_URL),
          redisUrl: envOr(options.redisUrl, ENV_REDIS_URL),
          checkRateLimitPerMinute: options.rateLimit
            ? Number(options.rateLimit)
            : undefined,
          auditRetentionDays: options.auditRetentionDays
            ? Number(options.auditRetentionDays)
            : undefined,
          defaultEffect: options.defaultEffect as DecisionEffect,
          enforcement:
            options.enforcement === undefined
              ? undefined
              : parseEnforcement(options.enforcement),
        });
        const tlsEnabled = Boolean(
          server.config.tlsCertFile &&
          server.config.tlsKeyFile &&
          server.config.tlsCaFile,
        );
        context.out.line(
          `Memnox runtime listening on ${tlsEnabled ? 'https' : 'http'}://${server.config.host}:${server.config.port}`,
        );
        context.out.line(
          server.config.policyFile
            ? `Policies: ${server.config.policyFile}`
            : 'No policy file loaded — every action gets the default effect. Run "memnox init".',
        );
        if (server.config.behaviorGuard) context.out.line('Behavior guard: enabled');
        if (server.config.trustGuard) context.out.line('Trust guard: enabled');
        context.out.line(
          server.config.embeddingApiKey
            ? 'Decision search: hybrid (keyword + embeddings)'
            : 'Decision search: keyword only (set --embedding-key for semantic search)',
        );
        if (server.config.dependencyGuard) {
          context.out.line(
            `Dependency guard: enabled (licenses: ${server.config.dependencyLicenseLookup ? 'npm registry' : 'offline table'})`,
          );
        }
        if (server.config.codeGraphFile && server.config.protectedPaths.length > 0) {
          context.out.line(
            `Blast radius: protecting ${server.config.protectedPaths.join(', ')}`,
          );
        }
        if (tlsEnabled) context.out.line('mTLS: client-certificate agent auth enabled');
        context.out.line(
          server.config.redisUrl
            ? 'Rate limits: shared via Redis'
            : 'Rate limits: per-process (set --redis-url to share them across pods)',
        );
        if (server.config.auditRetentionDays > 0) {
          context.out.line(`Audit retention: ${server.config.auditRetentionDays} days`);
        }
      },
    );
}
