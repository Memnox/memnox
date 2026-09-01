import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { parseEnforcement } from '../enforcement-args';
import { DECISION_EFFECT, type DecisionEffect } from '@memnox/core';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  ENCRYPTION_MODE,
  startServer,
  type EncryptionMode,
  type MemnoxServer,
  type RuntimeConfig,
} from '@memnox/runtime';

/** Injected so tests reach the config mapping and the banner. */
export type ServerLauncher = (
  overrides: Partial<RuntimeConfig>,
) => Promise<Pick<MemnoxServer, 'config'>>;

const VALID_DEFAULT_EFFECTS: readonly string[] = [
  DECISION_EFFECT.ALLOW,
  DECISION_EFFECT.WITHHOLD,
];

/** Container deployments configure secrets via environment; flags win when both are set. */
const ENV_ADMIN_TOKEN = 'MEMNOX_ADMIN_TOKEN';
const ENV_BASE_PATH = 'MEMNOX_BASE_PATH';
const ENV_DATA_KEY = 'MEMNOX_DATA_KEY';
const ENV_DATA_KEY_FILE = 'MEMNOX_DATA_KEY_FILE';
const ENV_KEYRING_FILE = 'MEMNOX_KEYRING_FILE';
const ENV_ENCRYPTION_MODE = 'MEMNOX_ENCRYPTION_MODE';
const ENV_TLS_CERT = 'MEMNOX_TLS_CERT';
const ENV_TLS_KEY = 'MEMNOX_TLS_KEY';
const ENV_TLS_CA = 'MEMNOX_TLS_CA';

const envOr = (value: string | undefined, name: string): string | undefined =>
  value ?? (process.env[name] || undefined);

const VALID_ENCRYPTION_MODES: string[] = [
  ENCRYPTION_MODE.OFF,
  ENCRYPTION_MODE.PERMISSIVE,
  ENCRYPTION_MODE.STRICT,
];

/** States both cases: an operator must never have to guess whether keys are on. */
function encryptionBanner(config: RuntimeConfig): string {
  const configured =
    config.keyringFile !== undefined ||
    config.keyring !== undefined ||
    config.dataKeyFile !== undefined ||
    config.dataEncryptionKey !== undefined;
  if (!configured) {
    return 'Encryption at rest: off (set --keyring-file to encrypt local stores)';
  }
  const legacy = config.keyringFile === undefined && config.keyring === undefined;
  const mode = config.dataEncryptionMode ?? (legacy ? 'permissive' : 'strict');
  return legacy
    ? `Encryption at rest: AES-256-GCM, legacy unsalted key (${mode}) — run "memnox keys rewrap"`
    : `Encryption at rest: AES-256-GCM, keyring (${mode})`;
}

/** A typo here would silently downgrade at-rest guarantees, so it is fatal. */
function encryptionMode(value: string | undefined): EncryptionMode | undefined {
  if (value === undefined) return undefined;
  if (!VALID_ENCRYPTION_MODES.includes(value)) {
    throw new Error(
      `--encryption-mode must be one of: ${VALID_ENCRYPTION_MODES.join(', ')}`,
    );
  }
  return value as EncryptionMode;
}

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
    .option(
      '--policies <path>',
      'YAML policy file (repeatable — one project may span several repositories)',
      (path: string, previous: string[]) => [...previous, path],
      [] as string[],
    )
    // Explicit, like every other guard here: a server must not start loading
    // rules from a developer's home directory because a default moved.
    .option(
      '--policy-registry <path>',
      'also load the rule files registered in this file (see "memnox pull")',
    )
    .option('--data-dir <path>', 'local data directory')
    .option('--admin-token <token>', 'require this bearer token on admin routes')
    .option(
      '--allow-local-admin',
      'serve admin routes unauthenticated when no token is set (loopback binds do this already)',
    )
    .option(
      '--tls-cert <path>',
      'TLS server certificate (enables mTLS with --tls-key/--tls-ca)',
    )
    .option('--tls-key <path>', 'TLS server private key')
    .option('--tls-ca <path>', 'CA bundle used to verify client certificates')
    .option('--slack-signing-secret <secret>', 'enable Slack interactive approvals')
    .option(
      '--data-key <key>',
      'encrypt local stores at rest with this key (deprecated: unsalted, cannot rotate — prefer --keyring-file)',
    )
    .option(
      '--data-key-file <path>',
      'read --data-key from a file so it never reaches argv',
    )
    .option(
      '--keyring-file <path>',
      'JSON keyring: an active key plus retired keys kept for reads',
    )
    .option(
      '--encryption-mode <mode>',
      'how to treat records with no envelope: off | permissive | strict',
    )
    .option(
      '--agent-jwt-secret <secret>',
      'accept HS256 agent JWTs signed with this value',
    )
    .option('--agent-jwt-issuer <issuer>', 'required issuer for agent JWTs')
    .option(
      '--rate-limit <rpm>',
      'per-agent requests/minute on the check endpoint (0 disables)',
    )
    .option(
      '--audit-retention-days <days>',
      'prune audit events older than this many days (0 disables)',
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
    .option(
      '--base-path <path>',
      'serve every /v1 route under this prefix, e.g. "/orbit", so several runtimes share one host',
    )
    .action(
      async (options: {
        port: string;
        host: string;
        policies: string[];
        policyRegistry?: string;
        dataDir?: string;
        basePath?: string;
        adminToken?: string;
        allowLocalAdmin?: boolean;
        tlsCert?: string;
        tlsKey?: string;
        tlsCa?: string;
        embeddingKey?: string;
        approvalWebhook?: string;
        slackSigningSecret?: string;
        dataKey?: string;
        dataKeyFile?: string;
        keyringFile?: string;
        encryptionMode?: string;
        agentJwtSecret?: string;
        agentJwtIssuer?: string;
        rateLimit?: string;
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
          policyFile: options.policies[0],
          policyFiles: options.policies.slice(1),
          ...(options.policyRegistry === undefined
            ? {}
            : { policyRegistryFile: options.policyRegistry }),
          dataDir: options.dataDir,
          basePath: envOr(options.basePath, ENV_BASE_PATH),
          adminToken: envOr(options.adminToken, ENV_ADMIN_TOKEN),
          allowLocalAdmin: options.allowLocalAdmin ?? false,
          tlsCertFile: envOr(options.tlsCert, ENV_TLS_CERT),
          tlsKeyFile: envOr(options.tlsKey, ENV_TLS_KEY),
          tlsCaFile: envOr(options.tlsCa, ENV_TLS_CA),
          approvalWebhookUrl: options.approvalWebhook,
          slackSigningSecret: options.slackSigningSecret,
          dataEncryptionKey: envOr(options.dataKey, ENV_DATA_KEY),
          dataKeyFile: envOr(options.dataKeyFile, ENV_DATA_KEY_FILE),
          keyringFile: envOr(options.keyringFile, ENV_KEYRING_FILE),
          dataEncryptionMode: encryptionMode(
            envOr(options.encryptionMode, ENV_ENCRYPTION_MODE),
          ),
          agentJwtSecret: options.agentJwtSecret,
          agentJwtIssuer: options.agentJwtIssuer,
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
        // Every source, not just the first: --policies repeats, and a registry adds more.
        const policySources = [
          ...(server.config.policyFile === undefined ? [] : [server.config.policyFile]),
          ...(server.config.policyFiles ?? []),
          ...(server.config.policyRegistryFile === undefined
            ? []
            : [`${server.config.policyRegistryFile} (registry)`]),
        ];
        if (policySources.length === 0) {
          context.out.line(
            'No policy file loaded — every action gets the default effect. Run "memnox init".',
          );
        } else {
          context.out.line(`Policies: ${policySources[0]}`);
          for (const source of policySources.slice(1)) {
            context.out.line(`${''.padEnd('Policies: '.length)}${source}`);
          }
        }
        context.out.line(
          server.config.allowLocalAdmin
            ? 'Management auth: OPEN — no token required on admin routes'
            : 'Management auth: bearer token required',
        );
        context.out.line(encryptionBanner(server.config));
        if (tlsEnabled) context.out.line('mTLS: client-certificate agent auth enabled');
        context.out.line('Rate limits: per-process — one machine, one runtime');
        if (server.config.auditRetentionDays > 0) {
          context.out.line(`Audit retention: ${server.config.auditRetentionDays} days`);
        }
      },
    );
}
