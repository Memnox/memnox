import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  AgentIdentity,
  ApiRole,
  EnvironmentModes,
  ExplanationStore,
  FixedWindowRateLimiter,
  SeamStore,
  TaskStore,
} from '@memnox/core';
import type { Policy } from '@memnox/policy-engine';
import type { PolicyHistory } from '../policy-history';
import type { ActionGateway } from '../action-gateway';
import type { ContainmentService } from '../containment-service';
import type { LearnService } from '../learn-service';
import { isAuthorizedFor } from '../auth';
import type { RuntimeConfig } from '../config';
import type { SeamService } from '../seam-service';
import type { FrameStore } from '@memnox/ledger';
import type { LineageService } from '../lineage-service';
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
  requireRole: RequireRole;
  rateLimiter: FixedWindowRateLimiter;
  metrics: MetricsRegistry;
  /** Re-reads the policy file; absent when the runtime started without one. */
  reloadPolicies?: () => Promise<Policy[]>;
  /** A caller that has just written a rule file needs to know whether it was read. */
  policySources?: () => Promise<string[]>;
  /** Persists a new rule set, then swaps the engine. Only when a file backs it. */
  applyPolicies?: (policies: Policy[]) => Promise<Policy[]>;
  /** The rules in the one file `applyPolicies` overwrites; absent when no file backs it. */
  writablePolicies?: () => Promise<Policy[] | null>;
  /** Writes the modes so a restart keeps them. Absent leaves them in memory. */
  persistEnforcement?: (modes: EnvironmentModes) => Promise<void>;
  /** Injected so proxy tests exercise real route code against a fake upstream. */
  proxyFetch: typeof fetch;
  /** Declared tasks: what a session was asked for, and the scope that implies. */
  tasks: TaskStore;
  /** Published rule sets, so a bad publish can be undone. */
  policyHistory: PolicyHistory;
  /** The explanation each verdict was built with, so `why` reads rather than retells. */
  explanations: ExplanationStore;
  /** Which seams are installed, in what mode, and what each one cannot see. */
  seams: SeamStore;
  /** Registration and the heartbeat that makes a stopped seam distinguishable. */
  seamService: SeamService;
  /** The flight recorder. Absent leaves a runtime that keeps verdicts and no timeline. */
  frames?: FrameStore;
  /** Who caused this: a person, through a tool, through an agent, to a system. */
  lineage: LineageService;
  /** Kill, quarantine and panic, each recording what it could not reach. */
  containment: ContainmentService;
  /** Usage against grant, and the least-privilege proposal that falls out of it. */
  learn: LearnService;
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
