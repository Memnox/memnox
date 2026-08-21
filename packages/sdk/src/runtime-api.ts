import type { ActionRequest, RiskAssessment } from '@memnox/core';
import { DECISION_EFFECT } from '@memnox/core';
import type { MemnoxClient } from './client';

/** Boolean predicates over check(). Pending approval counts as "not permitted". */
export const RUNTIME_ACTION = {
  ACCESS: 'resource.access',
  DEPLOY: 'deploy.service',
  MODIFY: 'code.modify',
  DELETE: 'resource.delete',
} as const;

export interface ResourceQuery {
  target?: string;
  environment?: string;
  sessionId?: string;
}

function toRequest(action: string, query: ResourceQuery): ActionRequest {
  return {
    action,
    ...(query.target ? { target: query.target } : {}),
    ...(query.environment ? { environment: query.environment } : {}),
    ...(query.sessionId ? { sessionId: query.sessionId } : {}),
  };
}

export class RuntimeApi {
  constructor(private readonly client: MemnoxClient) {}

  /** True only when the action may proceed right now, unattended. */
  async shouldExecute(request: ActionRequest): Promise<boolean> {
    const decision = await this.client.check(request);
    return decision.effect === DECISION_EFFECT.ALLOW;
  }

  canAccess(query: ResourceQuery): Promise<boolean> {
    return this.shouldExecute(toRequest(RUNTIME_ACTION.ACCESS, query));
  }

  canDeploy(query: ResourceQuery): Promise<boolean> {
    return this.shouldExecute(toRequest(RUNTIME_ACTION.DEPLOY, query));
  }

  canModify(query: ResourceQuery): Promise<boolean> {
    return this.shouldExecute(toRequest(RUNTIME_ACTION.MODIFY, query));
  }

  canDelete(query: ResourceQuery): Promise<boolean> {
    return this.shouldExecute(toRequest(RUNTIME_ACTION.DELETE, query));
  }

  /** What would happen, without it happening — nothing is audited. */
  evaluateRisk(request: ActionRequest): Promise<RiskAssessment> {
    return this.client.evaluateRisk(request);
  }
}

export interface PolicyApplyResult {
  applied: boolean;
  version: string;
  policyCount: number;
  policyNames: string[];
}

export interface PolicyReloadResult {
  reloaded: boolean;
  version: string;
  /** A caller that just wrote a rule file checks this rather than assuming a reload. */
  sources?: string[];
}

export interface PolicySetView {
  version: string;
  policyCount: number;
  policyNames: string[];
  policies: unknown[];
}
