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
import type { DecisionSemanticSearch } from '@memnox/memory';
import type { DecisionMemoryService } from '../decision-memory-service';
import type { OrganizationService } from '../organization-service';
import type { Policy } from '@memnox/policy-engine';
import type { PolicyHistory } from '../policy-history';
import type { ActionGateway } from '../action-gateway';
import type { ContainmentService } from '../containment-service';
import type { LearnService } from '../learn-service';
import type { DelegationService } from '../delegation-service';
import type { StateFactStore } from '../stores/json-file-state-store';
import type { CensusSource } from '@memnox/organization';
import type { ReadinessService } from '../readiness-service';
import { isAuthorizedFor, isScopedToWorkspace } from '../auth';
import type { RuntimeConfig } from '../config';
import type { SeamService } from '../seam-service';
import type { CapabilityBroker } from '../capability-broker';
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

/** Separate from `RequireRole`: one says what, the other says to whom. */
export type RequireWorkspace = (
  request: FastifyRequest,
  reply: FastifyReply,
  workspace: string,
) => boolean;

/** Everything a route module needs — one parameter per register function. */
export interface RouteContext {
  gateway: ActionGateway;
  config: RuntimeConfig;
  decisionMemory: DecisionMemoryService;
  /** The organization: context, authority, and the six answers over one gate verdict. */
  organization: OrganizationService;
  requireRole: RequireRole;
  /** Guards a workspace-scoped admin route; replies 403 and returns false when denied. */
  requireWorkspace: RequireWorkspace;
  rateLimiter: FixedWindowRateLimiter;
  metrics: MetricsRegistry;
  /** Set only when mTLS is on — resolves a verified client cert to an agent. */
  resolveCertAgent?: (request: FastifyRequest) => Promise<AgentIdentity | null>;
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
  /** Present only when an embedding key is configured; keyword search runs regardless. */
  semanticSearch?: DecisionSemanticSearch;
  /** The explanation each verdict was built with, so `why` reads rather than retells. */
  explanations: ExplanationStore;
  /** Which seams are installed, in what mode, and what each one cannot see. */
  seams: SeamStore;
  /** Registration and the heartbeat that makes a stopped seam distinguishable. */
  seamService: SeamService;
  /** Exchanges a request for a short lease, so nothing long-lived is handed over. */
  broker: CapabilityBroker;
  /** The flight recorder. Absent leaves a runtime that keeps verdicts and no timeline. */
  frames?: FrameStore;
  /** Who caused this: a person, through a tool, through an agent, to a system. */
  lineage: LineageService;
  /** Kill, quarantine and panic, each recording what it could not reach. */
  containment: ContainmentService;
  /** Usage against grant, and the least-privilege proposal that falls out of it. */
  learn: LearnService;
  /** Who may act for whom, through a chain that can only narrow. */
  delegations: DelegationService;
  /** The company's current condition, read as a policy input. */
  state: StateFactStore;
  /** Every source a census is taken from; each names the record that proved an agent. */
  censusSources: readonly CensusSource[];
  /** Readiness as queries over stores that exist, so nobody can tick an item. */
  readiness: ReadinessService;
}

export function createRequireRole(config: RuntimeConfig): RequireRole {
  return (request, reply, role) => {
    if (isAuthorizedFor(bearerToken(request), config, role)) return true;
    void reply.code(401).send({ error: 'unauthorized' });
    return false;
  };
}

export function createRequireWorkspace(config: RuntimeConfig): RequireWorkspace {
  return (request, reply, workspace) => {
    if (isScopedToWorkspace(bearerToken(request), config, workspace)) return true;
    void reply
      .code(403)
      .send({ error: 'this credential does not manage that workspace' });
    return false;
  };
}

export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith(BEARER_PREFIX)) return null;
  return header.slice(BEARER_PREFIX.length);
}
