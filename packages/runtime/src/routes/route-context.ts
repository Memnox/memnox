import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  AgentIdentity,
  ApiRole,
  EnvironmentModes,
  FixedWindowRateLimiter,
  PlanStore,
} from '@memnox/core';
import type { DecisionSemanticSearch } from '@memnox/memory';
import type { DecisionMemoryService } from '../decision-memory-service';
import type { Policy } from '@memnox/policy-engine';
import type { PolicyHistory } from '../policy-history';
import type { ActionGateway } from '../action-gateway';
import { isAuthorizedFor } from '../auth';
import type { RuntimeConfig } from '../config';
import type { MetricsRegistry } from '../metrics';

const BEARER_PREFIX = 'Bearer ';

/** Guards a route at the given role; replies 401 and returns false when denied. */
export type RequireRole = (
  request: FastifyRequest,
  reply: FastifyReply,
  role: ApiRole,
) => boolean;

/** Everything a route module needs — one parameter per register function. */
export interface RouteContext {
  gateway: ActionGateway;
  config: RuntimeConfig;
  decisionMemory: DecisionMemoryService;
  requireRole: RequireRole;
  rateLimiter: FixedWindowRateLimiter;
  metrics: MetricsRegistry;
  /** Set only when mTLS is on — resolves a verified client cert to an agent. */
  resolveCertAgent?: (request: FastifyRequest) => Promise<AgentIdentity | null>;
  /** Re-reads the policy file; absent when the runtime started without one. */
  reloadPolicies?: () => Promise<Policy[]>;
  /** Persists a new rule set, then swaps the engine. Only when a file backs it. */
  applyPolicies?: (policies: Policy[]) => Promise<Policy[]>;
  /** Writes the modes so a restart keeps them. Absent leaves them in memory. */
  persistEnforcement?: (modes: EnvironmentModes) => Promise<void>;
  /** Injected so proxy tests exercise real route code against a fake upstream. */
  proxyFetch: typeof fetch;
  /** Declared plans, scoping an autonomous run one step at a time. */
  plans: PlanStore;
  /** Published rule sets, so a bad publish can be undone. */
  policyHistory: PolicyHistory;
  /** Present only when an embedding key is configured; keyword search runs regardless. */
  semanticSearch?: DecisionSemanticSearch;
}

export function createRequireRole(config: RuntimeConfig): RequireRole {
  return (request, reply, role) => {
    if (isAuthorizedFor(bearerToken(request), config, role)) return true;
    void reply.code(401).send({ error: 'unauthorized' });
    return false;
  };
}

export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith(BEARER_PREFIX)) return null;
  return header.slice(BEARER_PREFIX.length);
}
