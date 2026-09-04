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
import { PolicyEngine, type Policy } from '@memnox/policy-engine';
import { ActionGateway } from './action-gateway';
import { scheduleAuditRetention } from './audit-retention';
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
import { registerApprovalRoutes } from './routes/approval.routes';
import { registerAuditRoutes } from './routes/audit.routes';
import { registerMetricsRoutes } from './routes/metrics.routes';
import { registerDecisionRoutes } from './routes/decision.routes';
import { registerEnforcementRoutes } from './routes/enforcement.routes';
import { registerPolicyRoutes } from './routes/policy.routes';
import { registerTaskRoutes } from './routes/task.routes';
import { registerProxyRoutes } from './routes/proxy.routes';
import { createRequireRole, type RouteContext } from './routes/route-context';
import { JsonFileApprovalStore } from './stores/json-file-approval-store';
import { JsonFileIdentityStore } from './stores/json-file-identity-store';
import { JsonlAuditLog } from './stores/jsonl-audit-log';
import { InMemoryExplanationStore } from './stores/in-memory-explanation-store';
import { InMemoryTaskStore } from './stores/in-memory-task-store';
import { JsonFileSeamStore } from './stores/json-file-seam-store';
import { JsonFileStateFactStore } from './stores/json-file-state-fact-store';
import { ContainmentService, LocalInstallDirectory } from './containment-service';
import { SeamService } from './seam-service';
import { LineageService } from './lineage-service';
import { registerOperateRoutes } from './routes/operate.routes';
import { registerSeamRoutes } from './routes/seam.routes';
import { registerStateRoutes } from './routes/state.routes';
import { registerFrameRoutes } from './routes/frame.routes';
import { LearnService } from './learn-service';
import { JsonlFrameStore } from './stores/jsonl-frame-store';
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
const STATE_FACTS_FILE = 'state-facts.json';
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
  /** Redis-backed when --redis-url is set, in-process otherwise. */
  lockService: LockService;
  metrics: MetricsRegistry;
}

/** Composition root: builds stores, advisors, and gateway, then hands out one context. */
export interface ServerServices {
  /** Injected so proxy tests exercise real route code against a fake upstream. */
  proxyFetch?: typeof fetch;
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
  // Files are the only backing: the local half runs with no infrastructure at all.
  const auditLog = new JsonlAuditLog(join(config.dataDir, AUDIT_FILE));
  const identityStore = new JsonFileIdentityStore(join(config.dataDir, AGENTS_FILE));

  const { lockService, sessionTaintStore } = await resolveCoordination();

  const taskStore = new InMemoryTaskStore();
  const seamStore = new JsonFileSeamStore(join(config.dataDir, SEAMS_FILE));
  const stateFactStore = new JsonFileStateFactStore(
    join(config.dataDir, STATE_FACTS_FILE),
  );
  const seamService = new SeamService({ store: seamStore, logger: CONSOLE_LOGGER });
  const frameStore = new JsonlFrameStore(join(config.dataDir, FRAMES_FILE));
  const policyHistory = new FilePolicyHistory(config.dataDir);
  // The flag wins a cold start; a stored map only fills in when none was given.
  const startingEnforcement =
    config.enforcement ?? (await readStoredEnforcement(config.dataDir));
  const approvalStore = new JsonFileApprovalStore(join(config.dataDir, APPROVALS_FILE));
  // One counter serves the HTTP limit and every per-rule rateLimit, so both are
  // shared across pods exactly when Redis is configured and per-instance otherwise.
  const rateLimiter = new FixedWindowRateLimiter(lockService);
  const explanations = new InMemoryExplanationStore();
  const gateway = new ActionGateway({
    explanations,
    tasks: taskStore,
    frames: frameStore,
    identityStore,
    auditLog,
    metrics,
    approvalStore,
    rateLimiter,
    stateFacts: stateFactStore,
    policyEngine: new PolicyEngine(policies, { defaultEffect: config.defaultEffect }),
    ...(startingEnforcement === undefined ? {} : { enforcement: startingEnforcement }),
    ...(config.maxPendingApprovals === undefined
      ? {}
      : { maxPendingPerAgent: config.maxPendingApprovals }),
    logger: CONSOLE_LOGGER,
    agentJwt: config.agentJwtSecret
      ? { secret: config.agentJwtSecret, issuer: config.agentJwtIssuer }
      : undefined,
  });

  const app = Fastify({ logger: false }) as FastifyInstance;
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

  const ctx: RouteContext = {
    gateway,
    config,
    explanations,
    seams: seamStore,
    seamService,
    stateFacts: stateFactStore,
    frames: frameStore,
    lineage: new LineageService({
      events: (sessionId) => gateway.queryAuditEvents({ sessionId }),
      frames: frameStore,
      logger: CONSOLE_LOGGER,
    }),
    learn: new LearnService({
      auditLog,
      rules: () => policies,
      seams: () => seamStore.list(),
    }),
    containment: new ContainmentService({
      seams: seamStore,
      installs: new LocalInstallDirectory(LOCAL_INSTALL_LABEL),
      subjects: {
        hold: async (agentId, status) =>
          (await gateway.agents.setStatus(agentId, status)) !== null,
      },
      logger: CONSOLE_LOGGER,
      raiseEnvironments: async (modes) => {
        await gateway.useEnforcement(modes);
        return 1;
      },
    }),
    metrics,
    requireRole: createRequireRole(config),
    rateLimiter,
    // Only offered when a file backs the rule set — there is nothing to re-read otherwise.
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
    registerTaskRoutes(scope, ctx);
    registerOperateRoutes(scope, ctx);
    registerSeamRoutes(scope, ctx);
    registerStateRoutes(scope, ctx);
    registerFrameRoutes(scope, ctx);
    registerProxyRoutes(scope, ctx);
    registerActionRoutes(scope, ctx);
    registerAgentRoutes(scope, ctx);
    registerAuditRoutes(scope, ctx);
    registerApprovalRoutes(scope, ctx);
    registerMetricsRoutes(scope, ctx);
    registerDecisionRoutes(scope, ctx);
    registerPolicyRoutes(scope, ctx);
    registerEnforcementRoutes(scope, ctx);
  };

  await app.register(mount, prefix === '' ? {} : { prefix });

  return { app, gateway, config, lockService, metrics };
}

interface Coordination {
  lockService: LockService;
  sessionTaintStore: SessionTaintStore;
}

/** One process, so both are in memory: nothing here is shared across machines. */
async function resolveCoordination(): Promise<Coordination> {
  return {
    lockService: new InProcessLockService(),
    sessionTaintStore: new InMemorySessionTaintStore(),
  };
}

export async function startServer(
  overrides: Partial<RuntimeConfig> = {},
): Promise<MemnoxServer> {
  const server = await buildServer(overrides);
  await server.app.listen({ port: server.config.port, host: server.config.host });
  return server;
}
