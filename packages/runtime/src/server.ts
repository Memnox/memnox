import Fastify, { type FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  ActionAdvisor,
  AuditLog,
  LockService,
  PlanStore,
  SessionTaintStore,
} from '@memnox/core';
import {
  FixedWindowRateLimiter,
  InMemoryPlanStore,
  InMemorySessionTaintStore,
  InProcessLockService,
} from '@memnox/core';
import {
  assertRedisReachable,
  connectRedis,
  RedisLockService,
  RedisSessionTaintStore,
  type RedisLike,
} from '@memnox/redis';
import { BlastRadiusAdvisor, type CodeGraph } from '@memnox/code-graph';
import { ContentShieldAdvisor } from '@memnox/content-shield';
import {
  DecisionMemoryAdvisor,
  DecisionSemanticSearch,
  InMemoryVectorIndex,
  JsonFileDecisionStore,
  type DecisionStore,
} from '@memnox/memory';
import { OpenAiEmbeddingProvider } from '@memnox/intelligence';
import { PolicyEngine, type Policy } from '@memnox/policy-engine';
import {
  BehaviorAdvisor,
  DependencyAdvisor,
  NpmRegistryLicenseResolver,
  StaticLicenseResolver,
  TaintAdvisor,
  PlanScopeAdvisor,
  ShellIndirectionAdvisor,
  TokenBudgetAdvisor,
  TrustAdvisor,
  VerificationAdvisor,
} from '@memnox/risk';
import { ActionGateway } from './action-gateway';
import { DecisionMemoryService } from './decision-memory-service';
import { scheduleAuditRetention } from './audit-retention';
import { loadCodeGraphFromFile } from './code-graph-loader';
import { peerCertificate, resolveAgentFromClientCert } from './client-cert';
import { resolveLocalMode } from './auth';
import { DEFAULT_ADVISOR_APPROVERS, resolveConfig, type RuntimeConfig } from './config';
import { CONSOLE_LOGGER } from './console-logger';
import { MetricsRegistry } from './metrics';
import { readStoredEnforcement, writeStoredEnforcement } from './enforcement-file';
import { FilePolicyHistory } from './policy-history';
import {
  loadPolicyFiles,
  readPolicyRegistry,
  writePoliciesToFile,
} from '@memnox/local-gate';
import { registerActionRoutes } from './routes/action.routes';
import { registerAgentRoutes } from './routes/agent.routes';
import { registerApprovalRoutes } from './routes/approval.routes';
import { registerAuditRoutes } from './routes/audit.routes';
import { registerMemoryRoutes } from './routes/memory.routes';
import { registerMetricsRoutes } from './routes/metrics.routes';
import { registerDecisionRoutes } from './routes/decision.routes';
import { registerEnforcementRoutes } from './routes/enforcement.routes';
import { registerPolicyRoutes } from './routes/policy.routes';
import { registerPlanRoutes } from './routes/plan.routes';
import { registerProxyRoutes } from './routes/proxy.routes';
import { createRequireRole, type RouteContext } from './routes/route-context';
import { buildCodec } from './keyring-loader';
import {
  connectPostgres,
  postgresOptionsFromEnv,
  ensureRuntimeSchema,
  PostgresApprovalStore,
  PostgresAuditLog,
  PostgresDecisionStore,
  PostgresIdentityStore,
  createPostgresVectorIndex,
  type SqlClient,
} from '@memnox/postgres';
import { JsonFileApprovalStore } from './stores/json-file-approval-store';
import { JsonFileIdentityStore } from './stores/json-file-identity-store';
import { JsonlAuditLog } from './stores/jsonl-audit-log';
import { WebhookApprovalNotifier } from './webhook-approval-notifier';

/** "orbit" and "/orbit/" are one prefix; Fastify wants exactly one leading slash. */
export function normalizeBasePath(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? '' : `/${trimmed}`;
}

const AGENTS_FILE = 'agents.json';
const AUDIT_FILE = 'audit.jsonl';
const DECISIONS_FILE = 'decisions.json';
const APPROVALS_FILE = 'approvals.json';

export interface MemnoxServer {
  app: FastifyInstance;
  gateway: ActionGateway;
  config: RuntimeConfig;
  decisionStore: DecisionStore;
  /** Redis-backed when --redis-url is set, in-process otherwise. */
  lockService: LockService;
  metrics: MetricsRegistry;
}

/**
 * Composition root: builds the stores, advisors, and gateway from config,
 * then hands one RouteContext to each interface-layer route module.
 */
export interface ServerServices {
  /** Injected SQL client (tests use pg-mem); default = connect via config.databaseUrl. */
  sql?: SqlClient;
  /** Injected Redis client (tests use a stub); default = connect via config.redisUrl. */
  redis?: RedisLike;
  /** Injected so proxy tests exercise real route code against a fake upstream. */
  proxyFetch?: typeof fetch;
  /**
   * Startup probe budget. The default spends 5s proving an unreachable Redis
   * really is unreachable, which is right at boot and far too long for a test
   * asserting only that the failure propagates.
   */
  redisProbe?: { attempts: number; delayMs: number };
}

/**
 * An `arguments:` rule is decided by the in-process gate, because the payload it
 * matches never reaches this process. Saying so at boot keeps such a rule from
 * looking enforced here when nothing local is configured to enforce it.
 */
function reportArgumentRules(policies: readonly Policy[]): void {
  const named = policies.filter((policy) => policy.match.arguments !== undefined);
  if (named.length === 0) return;

  CONSOLE_LOGGER.info(
    `${named.length} rule(s) match on call arguments (${named
      .map((policy) => policy.name)
      .join(', ')}) — those are decided by @memnox/local-gate in the process that ` +
      'makes the call (MEMNOX_POLICIES for the MCP firewall, the policy file for the editor hook), not here.',
  );
}

export async function buildServer(
  overrides: Partial<RuntimeConfig> = {},
  services: ServerServices = {},
): Promise<MemnoxServer> {
  const config = resolveLocalMode(resolveConfig(overrides), CONSOLE_LOGGER);
  // Boot and reload resolve sources the same way, so a reload can never see a
  // different rule set than a restart would.
  const policySources = async (): Promise<string[]> => {
    const registered =
      config.policyRegistryFile === undefined
        ? []
        : await readPolicyRegistry(config.policyRegistryFile);
    const configured = [
      ...(config.policyFile === undefined ? [] : [config.policyFile]),
      ...(config.policyFiles ?? []),
      ...registered,
    ];
    // Absolute before deduping: `setup` passes the file relatively and registers
    // it absolutely, and two spellings of one path loaded every rule in it twice.
    return [...new Set(configured.map((source) => resolve(source)))];
  };
  const policies = await loadPolicyFiles(await policySources());
  reportArgumentRules(policies);
  const codeGraph = config.codeGraphFile
    ? await loadCodeGraphFromFile(config.codeGraphFile, CONSOLE_LOGGER)
    : null;

  const metrics = new MetricsRegistry();
  const codec = await buildCodec(config, metrics, CONSOLE_LOGGER);
  // Postgres = shared state for horizontally scaled deployments; files = zero-infrastructure default.
  const sql: SqlClient | null =
    services.sql ??
    (config.databaseUrl
      ? connectPostgres(
          config.databaseUrl,
          postgresOptionsFromEnv(process.env, 'MEMNOX_DB_'),
        )
      : null);
  if (sql) await ensureRuntimeSchema(sql);
  const auditLog = sql
    ? new PostgresAuditLog(sql, codec)
    : new JsonlAuditLog(join(config.dataDir, AUDIT_FILE), codec);
  const decisionStore = sql
    ? new PostgresDecisionStore(sql, codec)
    : new JsonFileDecisionStore(join(config.dataDir, DECISIONS_FILE), codec);

  const identityStore = sql
    ? new PostgresIdentityStore(sql, codec)
    : new JsonFileIdentityStore(join(config.dataDir, AGENTS_FILE), codec);

  const semanticSearch = await buildSemanticSearch(config, sql);

  const { lockService, sessionTaintStore } = await resolveCoordination(config, services);

  const planStore = new InMemoryPlanStore();
  const policyHistory = new FilePolicyHistory(config.dataDir, codec);
  // The flag wins a cold start; a stored map only fills in when none was given.
  const startingEnforcement =
    config.enforcement ?? (await readStoredEnforcement(config.dataDir));
  const approvalStore = sql
    ? new PostgresApprovalStore(sql, codec)
    : new JsonFileApprovalStore(join(config.dataDir, APPROVALS_FILE), codec);
  // One counter serves the HTTP limit and every per-rule rateLimit, so both are
  // shared across pods exactly when Redis is configured and per-instance otherwise.
  const rateLimiter = new FixedWindowRateLimiter(lockService);
  const gateway = new ActionGateway({
    identityStore,
    auditLog,
    metrics,
    approvalStore,
    rateLimiter,
    policyEngine: new PolicyEngine(policies, { defaultEffect: config.defaultEffect }),
    ...(startingEnforcement === undefined ? {} : { enforcement: startingEnforcement }),
    ...(config.maxPendingApprovals === undefined
      ? {}
      : { maxPendingPerAgent: config.maxPendingApprovals }),
    advisors: buildAdvisors(
      config,
      auditLog,
      decisionStore,
      sessionTaintStore,
      codeGraph,
      planStore,
    ),
    notifier: config.approvalWebhookUrl
      ? new WebhookApprovalNotifier(config.approvalWebhookUrl)
      : undefined,
    logger: CONSOLE_LOGGER,
    agentJwt: config.agentJwtSecret
      ? { secret: config.agentJwtSecret, issuer: config.agentJwtIssuer }
      : undefined,
  });

  const tls = await loadTlsOptions(config);
  // requestCert without rejectUnauthorized: token-only clients still connect; cert auth is per request.
  const app = (
    tls
      ? Fastify({
          logger: false,
          https: { ...tls, requestCert: true, rejectUnauthorized: false },
        })
      : Fastify({ logger: false })
  ) as FastifyInstance;
  // Only end connections this server opened — injected clients belong to the caller.
  if (sql && !services.sql) app.addHook('onClose', async () => sql.end());
  const stopRetention = scheduleAuditRetention(
    auditLog,
    approvalStore,
    lockService,
    config.auditRetentionDays,
    CONSOLE_LOGGER,
  );
  app.addHook('onClose', async () => stopRetention());
  app.get('/healthz', async () => ({ status: 'ok' }));

  const ctx: RouteContext = {
    gateway,
    config,
    decisionMemory: new DecisionMemoryService({
      store: decisionStore,
      auditEvents: () => gateway.queryAuditEvents({}),
      semanticSearch,
    }),
    metrics,
    requireRole: createRequireRole(config),
    rateLimiter,
    resolveCertAgent: tls
      ? (request) => resolveAgentFromClientCert(peerCertificate(request), identityStore)
      : undefined,
    // Only offered when a file backs the rule set — there is nothing to re-read otherwise.
    semanticSearch,
    proxyFetch: services.proxyFetch ?? fetch,
    plans: planStore,
    policyHistory,
    reloadPolicies:
      config.policyFile || config.policyRegistryFile
        ? async () => {
            const reloaded = await loadPolicyFiles(await policySources());
            gateway.usePolicyEngine(
              new PolicyEngine(reloaded, { defaultEffect: config.defaultEffect }),
            );
            return reloaded;
          }
        : undefined,
    applyPolicies: config.policyFile
      ? async (policies) => {
          await writePoliciesToFile(config.policyFile ?? '', policies);
          gateway.usePolicyEngine(
            new PolicyEngine(policies, { defaultEffect: config.defaultEffect }),
          );
          return policies;
        }
      : undefined,
    persistEnforcement: (modes) => writeStoredEnforcement(config.dataDir, modes),
  };
  /* Mounted as one plugin so the prefix cannot be applied to some routes and
     forgotten on others. `/healthz` stays at the root as well, because an
     infrastructure probe knows the host and not the tenant. */
  const prefix = normalizeBasePath(config.basePath);
  const mount = async (scope: FastifyInstance): Promise<void> => {
    // Worth having per tenant under a prefix; at the root it is already above.
    if (prefix !== '') scope.get('/healthz', async () => ({ status: 'ok' }));
    registerPlanRoutes(scope, ctx);
    registerProxyRoutes(scope, ctx);
    registerActionRoutes(scope, ctx);
    registerAgentRoutes(scope, ctx);
    registerAuditRoutes(scope, ctx);
    registerApprovalRoutes(scope, ctx);
    registerMemoryRoutes(scope, ctx);
    registerMetricsRoutes(scope, ctx);
    registerDecisionRoutes(scope, ctx);
    registerPolicyRoutes(scope, ctx);
    registerEnforcementRoutes(scope, ctx);
  };

  await app.register(mount, prefix === '' ? {} : { prefix });

  return { app, gateway, config, decisionStore, lockService, metrics };
}

interface Coordination {
  lockService: LockService;
  sessionTaintStore: SessionTaintStore;
}

/** A configured Redis must work: silently falling back multiplies every limit by the pod count. */
async function resolveCoordination(
  config: RuntimeConfig,
  services: ServerServices,
): Promise<Coordination> {
  if (!services.redis && !config.redisUrl) {
    return {
      lockService: new InProcessLockService(),
      sessionTaintStore: new InMemorySessionTaintStore(),
    };
  }
  const client = services.redis ?? connectRedis(config.redisUrl ?? '');
  const locks = new RedisLockService(client, CONSOLE_LOGGER);
  const probe = services.redisProbe;
  if (probe === undefined) await assertRedisReachable(locks);
  else await assertRedisReachable(locks, probe.attempts, probe.delayMs);
  return {
    lockService: locks,
    sessionTaintStore: new RedisSessionTaintStore(client, locks, CONSOLE_LOGGER),
  };
}

export async function startServer(
  overrides: Partial<RuntimeConfig> = {},
): Promise<MemnoxServer> {
  const server = await buildServer(overrides);
  await server.app.listen({ port: server.config.port, host: server.config.host });
  return server;
}

interface TlsFileOptions {
  cert: Buffer;
  key: Buffer;
  ca: Buffer;
}

async function loadTlsOptions(config: RuntimeConfig): Promise<TlsFileOptions | null> {
  if (!config.tlsCertFile || !config.tlsKeyFile || !config.tlsCaFile) return null;
  const [cert, key, ca] = await Promise.all([
    readFile(config.tlsCertFile),
    readFile(config.tlsKeyFile),
    readFile(config.tlsCaFile),
  ]);
  return { cert, key, ca };
}

function buildAdvisors(
  config: RuntimeConfig,
  auditLog: AuditLog,
  decisionStore: DecisionStore,
  sessionTaintStore: SessionTaintStore,
  codeGraph: CodeGraph | null,
  plans: PlanStore,
): ActionAdvisor[] {
  const advisors: ActionAdvisor[] = [];
  if (config.contentShield) {
    advisors.push(new ContentShieldAdvisor());
  }
  if (codeGraph && config.protectedPaths.length > 0) {
    advisors.push(
      new BlastRadiusAdvisor(codeGraph, {
        protectedPaths: config.protectedPaths,
        approvers: [...DEFAULT_ADVISOR_APPROVERS],
      }),
    );
  }
  // Escalates only when callers report taint — always safe to keep on.
  advisors.push(new TaintAdvisor(sessionTaintStore, CONSOLE_LOGGER));
  if (config.memoryEnabled) {
    advisors.push(
      new DecisionMemoryAdvisor(decisionStore, [...DEFAULT_ADVISOR_APPROVERS]),
    );
  }
  if (config.behaviorGuard) {
    advisors.push(new BehaviorAdvisor(auditLog, [...DEFAULT_ADVISOR_APPROVERS]));
  }
  if (config.trustGuard) {
    advisors.push(new TrustAdvisor([...DEFAULT_ADVISOR_APPROVERS]));
  }
  if (config.verificationGuard) {
    advisors.push(new VerificationAdvisor(auditLog, [...DEFAULT_ADVISOR_APPROVERS]));
  }
  advisors.push(new PlanScopeAdvisor(plans));
  if (config.shellGuard) {
    advisors.push(new ShellIndirectionAdvisor(undefined, [...DEFAULT_ADVISOR_APPROVERS]));
  }
  if (config.sessionTokenBudget) {
    advisors.push(new TokenBudgetAdvisor(auditLog, config.sessionTokenBudget));
  }
  if (config.dependencyGuard) {
    advisors.push(
      new DependencyAdvisor(
        config.dependencyLicenseLookup
          ? new NpmRegistryLicenseResolver()
          : new StaticLicenseResolver(),
        DEFAULT_ADVISOR_APPROVERS,
      ),
    );
  }
  return advisors;
}

/** Present only with a BYOK embedding key; keyword search always works without one. */
async function buildSemanticSearch(
  config: RuntimeConfig,
  sql: SqlClient | null,
): Promise<DecisionSemanticSearch | undefined> {
  const apiKey = config.embeddingApiKey;
  if (!apiKey) return undefined;
  const provider = new OpenAiEmbeddingProvider({
    apiKey,
    ...(config.embeddingModel ? { model: config.embeddingModel } : {}),
  });
  return new DecisionSemanticSearch({
    index: sql
      ? await createPostgresVectorIndex(sql, {
          ...(config.embeddingDimensions === undefined
            ? {}
            : { dimensions: config.embeddingDimensions }),
          logger: CONSOLE_LOGGER,
        })
      : new InMemoryVectorIndex(),
    embed: (texts) => provider.embed(texts),
    logger: CONSOLE_LOGGER,
  });
}
