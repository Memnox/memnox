import Fastify, { type FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  PLAIN_TEXT_CODEC,
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
import { PolicyEngine } from '@memnox/policy-engine';
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
} from '@memnox/risk';
import { ActionGateway } from './action-gateway';
import { DecisionMemoryService } from './decision-memory-service';
import { scheduleAuditRetention } from './audit-retention';
import { loadCodeGraphFromFile } from './code-graph-loader';
import { peerCertificate, resolveAgentFromClientCert } from './client-cert';
import { DEFAULT_ADVISOR_APPROVERS, resolveConfig, type RuntimeConfig } from './config';
import { CONSOLE_LOGGER } from './console-logger';
import { MetricsRegistry } from './metrics';
import { FilePolicyHistory } from './policy-history';
import { loadPoliciesFromFile, writePoliciesToFile } from './policy-loader';
import { registerActionRoutes } from './routes/action.routes';
import { registerAgentRoutes } from './routes/agent.routes';
import { registerApprovalRoutes } from './routes/approval.routes';
import { registerAuditRoutes } from './routes/audit.routes';
import { registerMemoryRoutes } from './routes/memory.routes';
import { registerMetricsRoutes } from './routes/metrics.routes';
import { registerDecisionRoutes } from './routes/decision.routes';
import { registerPolicyRoutes } from './routes/policy.routes';
import { registerPlanRoutes } from './routes/plan.routes';
import { registerProxyRoutes } from './routes/proxy.routes';
import { createRequireRole, type RouteContext } from './routes/route-context';
import { AesGcmCodec } from './stores/aes-codec';
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
}

export async function buildServer(
  overrides: Partial<RuntimeConfig> = {},
  services: ServerServices = {},
): Promise<MemnoxServer> {
  const config = resolveConfig(overrides);
  const policies = config.policyFile ? await loadPoliciesFromFile(config.policyFile) : [];
  const codeGraph = config.codeGraphFile
    ? await loadCodeGraphFromFile(config.codeGraphFile, CONSOLE_LOGGER)
    : null;

  const codec = config.dataEncryptionKey
    ? new AesGcmCodec(config.dataEncryptionKey)
    : PLAIN_TEXT_CODEC;
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

  const metrics = new MetricsRegistry();
  const planStore = new InMemoryPlanStore();
  const policyHistory = new FilePolicyHistory(config.dataDir);
  const gateway = new ActionGateway({
    identityStore,
    auditLog,
    metrics,
    approvalStore: sql
      ? new PostgresApprovalStore(sql, codec)
      : new JsonFileApprovalStore(join(config.dataDir, APPROVALS_FILE), codec),
    policyEngine: new PolicyEngine(policies, { defaultEffect: config.defaultEffect }),
    ...(config.enforcement === undefined ? {} : { enforcement: config.enforcement }),
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
    // Shared across pods only when --redis-url is set; per-instance otherwise.
    rateLimiter: new FixedWindowRateLimiter(lockService),
    resolveCertAgent: tls
      ? (request) => resolveAgentFromClientCert(peerCertificate(request), identityStore)
      : undefined,
    // Only offered when a file backs the rule set — there is nothing to re-read otherwise.
    semanticSearch,
    proxyFetch: services.proxyFetch ?? fetch,
    plans: planStore,
    policyHistory,
    reloadPolicies: config.policyFile
      ? async () => {
          const reloaded = await loadPoliciesFromFile(config.policyFile ?? '');
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
  };
  registerPlanRoutes(app, ctx);
  registerProxyRoutes(app, ctx);
  registerActionRoutes(app, ctx);
  registerAgentRoutes(app, ctx);
  registerAuditRoutes(app, ctx);
  registerApprovalRoutes(app, ctx);
  registerMemoryRoutes(app, ctx);
  registerMetricsRoutes(app, ctx);
  registerDecisionRoutes(app, ctx);
  registerPolicyRoutes(app, ctx);

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
  await assertRedisReachable(locks);
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
