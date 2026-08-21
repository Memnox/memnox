import type {
  ActionAdvisor,
  ActionRequest,
  Advisory,
  AdvisoryContext,
} from '@memnox/core';
import {
  DEFAULT_WORKSPACE,
  evaluateAuthority,
  type AuthorityStore,
} from '@memnox/org-graph';

export const AUTHORITY_ADVISOR = 'authority-guard';

/** An advisor, not a rule: policy is a reviewed file, a grant is one person's fact. */
export class AuthorityAdvisor implements ActionAdvisor {
  readonly name = AUTHORITY_ADVISOR;

  constructor(
    private readonly grants: AuthorityStore,
    /** Injected so a test can place a grant's expiry on either side of "now". */
    private readonly now: () => Date = () => new Date(),
  ) {}

  async advise(request: ActionRequest, context: AdvisoryContext): Promise<Advisory[]> {
    const workspace = context.agent.orgId ?? DEFAULT_WORKSPACE;
    const verdict = evaluateAuthority(
      await this.grants.list(workspace),
      {
        principal: request.principal,
        agentName: context.agent.name,
        action: request.action,
        amount: request.amount,
      },
      this.now(),
    );
    if (verdict === null) return [];

    return [
      {
        source: this.name,
        escalateTo: verdict.escalateTo,
        reason: verdict.reason,
        approvers: verdict.approvers,
        signals: [verdict.signal],
      },
    ];
  }
}
