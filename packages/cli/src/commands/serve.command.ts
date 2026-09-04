import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { parseEnforcement } from '../enforcement-args';
import {
  DECISION_EFFECT,
  DEFAULT_HOST,
  DEFAULT_PORT,
  type DecisionEffect,
} from '@memnox/core';
import type { MemnoxServer, RuntimeConfig } from '@memnox/runtime';

/* Imported here and not at the top: fastify costs ~170ms to load, and every
   command that never serves was paying it. */
const defaultLauncher: ServerLauncher = async (overrides) => {
  const { startServer } = await import('@memnox/runtime');
  return startServer(overrides);
};

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

const envOr = (value: string | undefined, name: string): string | undefined =>
  value ?? (process.env[name] || undefined);

export function registerServeCommand(
  program: Command,
  context: CliContext,
  launch: ServerLauncher = defaultLauncher,
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
      'also load the rule files registered in this file (written by "memnox setup")',
    )
    .option('--data-dir <path>', 'local data directory')
    .option('--admin-token <token>', 'require this bearer token on admin routes')
    .option(
      '--allow-local-admin',
      'serve admin routes unauthenticated when no token is set (loopback binds do this already)',
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
        context.out.line(
          `Memnox runtime listening on http://${server.config.host}:${server.config.port}`,
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
        context.out.line('Rate limits: per-process — one machine, one runtime');
        if (server.config.auditRetentionDays > 0) {
          context.out.line(`Audit retention: ${server.config.auditRetentionDays} days`);
        }
      },
    );
}
