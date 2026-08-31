import Fastify, { type FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  ActionAdvisor,
  AuditLog,
  LockService,
  SessionTaintStore,
} from '@memnox/core';
import {
  FixedWindowRateLimiter,
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
import {
  DecisionMemoryAdvisor,
  DecisionSemanticSearch,
  InMemoryVectorIndex,
  JsonFileDecisionStore,
  type DecisionStore,
} from '@memnox/memory';
import { OpenAiEmbeddingProvider } from '@memnox/intelligence';
import { PolicyEngine, type Policy } from '@memnox/policy-engine';
import type { AuthorityStore } from '@memnox/org-graph';
import {
  AuthorityAdvisor,
  BehaviorAdvisor,
  TaintAdvisor,
  ShellIndirectionAdvisor,
  TokenBudgetAdvisor,
  VerificationAdvisor,
} from '@memnox/risk';
import { ActionGateway } from './action-gateway';
import { DecisionMemoryService } from './decision-memory-service';
import { scheduleAuditRetention } from './audit-retention';
import { peerCertificate, resolveAgentFromClientCert } from './client-cert';
import { resolveLocalMode } from './auth';
import { DEFAULT_ADVISOR_APPROVERS, resolveConfig, type RuntimeConfig } from './config';
import { CONSOLE_LOGGER } from './console-logger';
import { MetricsRegistry } from './metrics';
import { readStoredEnforcement, writeStoredEnforcement } from './enforcement-file';
import { FilePolicyHistory } from './policy-history';
import {
  loadPolicyFiles,
  type OptionalPolicySources,
  readPolicyRegistry,
  writePoliciesToFile,
} from '@memnox/local-gate';
import { registerActionRoutes } from './routes/action.routes';
import { registerAgentRoutes } from './routes/agent.routes';
import { registerDashboardRoutes } from './routes/dashboard.routes';
import { registerApprovalRoutes } from './routes/approval.routes';
import { registerAuditRoutes } from './routes/audit.routes';
import { registerMemoryRoutes } from './routes/memory.routes';
import { registerMetricsRoutes } from './routes/metrics.routes';
import { registerDecisionRoutes } from './routes/decision.routes';
import { registerEnforcementRoutes } from './routes/enforcement.routes';
import { registerOrganizationAdminRoutes } from './routes/organization-admin.routes';
import { registerOrganizationRoutes } from './routes/organization.routes';
import { registerPolicyRoutes } from './routes/policy.routes';
import { registerTaskRoutes } from './routes/task.routes';
import { registerProxyRoutes } from './routes/proxy.routes';
import {
  createRequireRole,
  createRequireWorkspace,
  type RouteContext,
} from './routes/route-context';
import { OrganizationService } from './organization-service';
import { JsonFileStatedStore } from './stores/json-file-stated-store';
import { JsonFileAuthorityStore } from './stores/json-file-authority-store';
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
import { InMemoryExplanationStore } from './stores/in-memory-explanation-store';
import { InMemoryTaskStore } from './stores/in-memory-task-store';
import { JsonFileSeamStore } from './stores/json-file-seam-store';
import { ContainmentService, LocalInstallDirectory } from './containment-service';
import { CapabilityBroker } from './capability-broker';
import {
  InMemoryCapabilityStore,
  InMemoryLeaseStore,
} from './stores/in-memory-capability-store';
import { registerOperateRoutes } from './routes/operate.routes';
import { LearnService } from './learn-service';
import { DelegationService, InMemoryDelegationStore } from './delegation-service';
import { JsonFileStateStore } from './stores/json-file-state-store';
import { JsonlFrameStore } from './stores/jsonl-frame-store';
import { WebhookApprovalNotifier } from './webhook-approval-notifier';
import { registerSecurityHeaders } from './security-headers';

/** "orbit" and "/orbit/" are one prefix; Fastify wants exactly one leading slash. */
export function normalizeBasePath(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? '' : `/${trimmed}`;
}

const AGENTS_FILE = 'agents.json';
const AUDIT_FILE = 'audit.jsonl';
const DECISIONS_FILE = 'decisions.json';
const APPROVALS_FILE = 'approvals.json';
const SEAMS_FILE = 'seams.json';
const FRAMES_FILE = 'frames.jsonl';
const STATE_FILE = 'state.json';
/** One machine, always reachable, because it is this process. */
const LOCAL_INSTALL_LABEL = 'this machine';
const STATED_FILE = 'organization.json';
const AUTHORITY_FILE = 'authority.json';

export interface MemnoxServer {
  app: FastifyInstance;
  gateway: ActionGateway;
  config: RuntimeConfig;
  decisionStore: DecisionStore;
  /** Redis-backed when --redis-url is set, in-process otherwise. */
  lockService: LockService;
  metrics: MetricsRegistry;
}

/** Composition root: builds stores, advisors, and gateway, then hands out one context. */
export interface ServerServices {
  /** Injected SQL client (tests use pg-mem); default = connect via config.databaseUrl. */
  sql?: SqlClient;
  /** Injected Redis client (tests use a stub); default = connect via config.redisUrl. */
  redis?: RedisLike;
  /** Injected so proxy tests exercise real route code against a fake upstream. */
  proxyFetch?: typeof fetch;
  /** The default spends 5s proving an unreachable Redis really is unreachable. */
  redisProbe?: { attempts: number; delayMs: number };
}

/** Said at boot so such a rule cannot look enforced here when nothing local enforces it. */
function reportArgumentRules(policies: readonly Policy[]): void {
  const named = policies.filter((policy) => policy.match.arguments !== undefined);
  if (named.length === 0) return;

  CONSOLE_LOGGER.info(
    `${named.length} rule(s) match on call arguments (${named
      .map((policy) => policy.name)
      .join(', ')}) — those are decided by @memnox/local-gate in the process that ` +
      'makes the call (MEMNOX_POLICIES for the MCP firewall), not here.',
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
  /** Registered by another repo, so its checkout may be gone; this run's own files may not. */
  const optionalSources = async (): Promise<OptionalPolicySources> => {
    const named = new Set(
      [
        ...(config.policyFile === undefined ? [] : [config.policyFile]),
        ...(config.policyFiles ?? []),
      ].map((source) => resolve(source)),
    );
    const registered =
      config.policyRegistryFile === undefined
        ? []
        : await readPolicyRegistry(config.policyRegistryFile);
    return {
      optional: new Set(
        registered
          .map((source) => resolve(source))
          .filter((source) => !named.has(source)),
      ),
      onSkipped: (filePath) =>
        CONSOLE_LOGGER.warn(
          `registered policy file is gone, skipping it: ${filePath} — remove it from ` +
            `${config.policyRegistryFile ?? 'the policy registry'} to silence this`,
        ),
    };
  };
  const policies = await loadPolicyFiles(await policySources(), await optionalSources());
  reportArgumentRules(policies);

  const metrics = new MetricsRegistry();
  const codec = await buildCodec(config, metrics, CONSOLE_LOGGER);
  // Postgres for scaled deployments; files are the zero-infrastructure default.
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

  /* File-backed on every deployment for now: what the organization states is
     small, reviewed by hand, and argued about in a diff. It moves behind a SQL
     adapter when a tenant outgrows that, not before. */
  const statedStore = new JsonFileStatedStore(join(config.dataDir, STATED_FILE), codec);
  const authorityStore = new JsonFileAuthorityStore(
    join(config.dataDir, AUTHORITY_FILE),
    codec,
  );

  const semanticSearch = await buildSemanticSearch(config, sql);

  const { lockService, sessionTaintStore } = await resolveCoordination(config, services);

  const taskStore = new InMemoryTaskStore();
  const seamStore = new JsonFileSeamStore(join(config.dataDir, SEAMS_FILE), codec);
  const frameStore = new JsonlFrameStore(join(config.dataDir, FRAMES_FILE));
  const stateStore = new JsonFileStateStore(join(config.dataDir, STATE_FILE), codec);
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
  const explanations = new InMemoryExplanationStore();
  const gateway = new ActionGateway({
    explanations,
    tasks: taskStore,
    frames: frameStore,
    state: stateStore,
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
      authorityStore,
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
  // requestCert without rejectUnauthorized: token-only clients still connect.
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
  registerSecurityHeaders(app);
  app.get('/healthz', async () => ({ status: 'ok' }));

  const decisionMemory = new DecisionMemoryService({
    store: decisionStore,
    auditEvents: () => gateway.queryAuditEvents({}),
    semanticSearch,
  });
  const broker = new CapabilityBroker({
    capabilities: new InMemoryCapabilityStore(),
    leases: new InMemoryLeaseStore(),
    gateway,
    logger: CONSOLE_LOGGER,
  });
  const ctx: RouteContext = {
    gateway,
    config,
    explanations,
    seams: seamStore,
    delegations: new DelegationService({
      store: new InMemoryDelegationStore(),
      logger: CONSOLE_LOGGER,
    }),
    state: stateStore,
    learn: new LearnService({
      auditLog,
      rules: () => policies,
      seams: () => seamStore.list(),
    }),
    containment: new ContainmentService({
      seams: seamStore,
      broker,
      installs: new LocalInstallDirectory(LOCAL_INSTALL_LABEL),
      logger: CONSOLE_LOGGER,
      raiseEnvironments: async (modes) => {
        await gateway.useEnforcement(modes);
        return 1;
      },
    }),
    decisionMemory,
    organization: new OrganizationService({
      gateway,
      statements: statedStore,
      grants: authorityStore,
      decisions: decisionMemory,
    }),
    metrics,
    requireRole: createRequireRole(config),
    requireWorkspace: createRequireWorkspace(config),
    rateLimiter,
    resolveCertAgent: tls
      ? (request) => resolveAgentFromClientCert(peerCertificate(request), identityStore)
      : undefined,
    // Only offered when a file backs the rule set — there is nothing to re-read otherwise.
    semanticSearch,
    proxyFetch: services.proxyFetch ?? fetch,
    tasks: taskStore,
    policyHistory,
    reloadPolicies:
      config.policyFile || config.policyRegistryFile
        ? async () => {
            const reloaded = await loadPolicyFiles(
              await policySources(),
              await optionalSources(),
            );
            gateway.usePolicyEngine(
              new PolicyEngine(reloaded, { defaultEffect: config.defaultEffect }),
            );
            return reloaded;
          }
        : undefined,
    policySources,
    writablePolicies: config.policyFile
      ? async () => {
          try {
            return await loadPolicyFiles([config.policyFile ?? '']);
          } catch (err) {
            // Null says "no answer", so an editor falls back to read-only.
            CONSOLE_LOGGER.warn(
              `could not read ${config.policyFile ?? ''} to list editable rules: ${String(err)}`,
            );
            return null;
          }
        }
      : undefined,
    applyPolicies: config.policyFile
      ? async (policies) => {
          await writePoliciesToFile(config.policyFile ?? '', policies);
          // Recomposed from every source: swapping dropped the org bundle on any write.
          const composed = await loadPolicyFiles(
            await policySources(),
            await optionalSources(),
          );
          gateway.usePolicyEngine(
            new PolicyEngine(composed, { defaultEffect: config.defaultEffect }),
          );
          return composed;
        }
      : undefined,
    persistEnforcement: (modes) => writeStoredEnforcement(config.dataDir, modes),
  };
  /* Mounted as one plugin so the prefix cannot be applied to some routes and
     forgotten on others. `/healthz` stays at the root as well, because an
     infrastructure probe knows the host and not the tenant. */
  const prefix = normalizeBasePath(config.basePath);
  const mount = async (scope: FastifyInstance): Promise<void> => {
    /* Worth having per tenant under a prefix; at the root it is already above.
       It names the tenant as well as the status, because the address alone does
       not prove the runtime behind it is this workspace's own: a router that
       strips the prefix in front of one single-tenant runtime answers every
       `<base>/<id>` alike, and a control plane that cannot tell the difference
       binds every workspace to one store. The root probe declares no tenant,
       which is the honest answer for a deployment serving whoever reaches it. */
    if (prefix !== '')
      scope.get('/healthz', async () => ({ status: 'ok', tenant: prefix.slice(1) }));
    registerDashboardRoutes(scope, ctx);
    registerTaskRoutes(scope, ctx);
    registerOperateRoutes(scope, ctx);
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
    registerOrganizationRoutes(scope, ctx);
    registerOrganizationAdminRoutes(scope, ctx);
  };

  await app.register(mount, prefix === '' ? {} : { prefix });

  return { app, gateway, config, decisionStore, lockService, metrics };
}

interface Coordination {
  lockService: LockService;
  sessionTaintStore: SessionTaintStore;
}

/** A configured Redis must work: falling back multiplies every limit by pod count. */
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
  grants: AuthorityStore,
): ActionAdvisor[] {
  const advisors: ActionAdvisor[] = [];
  /* Always on, and free when nothing is delegated: with no grant recorded for a
     principal the advisor returns nothing, so switching it on cannot stop work
     that was running the day before. */
  advisors.push(new AuthorityAdvisor(grants));
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
  if (config.verificationGuard) {
    advisors.push(new VerificationAdvisor(auditLog, [...DEFAULT_ADVISOR_APPROVERS]));
  }
  if (config.shellGuard) {
    advisors.push(new ShellIndirectionAdvisor(undefined, [...DEFAULT_ADVISOR_APPROVERS]));
  }
  if (config.sessionTokenBudget) {
    advisors.push(new TokenBudgetAdvisor(auditLog, config.sessionTokenBudget));
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
