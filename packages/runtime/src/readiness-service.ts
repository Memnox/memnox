import type { AgentIdentity, IdentityStore, SeamStore } from '@memnox/core';
import { ENFORCEMENT_MODE } from '@memnox/core';
import {
  AUTONOMY_LEVEL,
  AUTONOMY_LEVEL_NAME,
  READINESS_ITEM,
  READINESS_STATUS,
  assessReadiness,
  type AutonomyLevel,
  type AutonomyLevelKey,
  type Readiness,
  type ReadinessItem,
} from '@memnox/autonomy';
import type { Policy } from '@memnox/policy-engine';
import type { DelegationService } from './delegation-service';
import type { LearnService } from './learn-service';

/** What each level means, as a named pack of rules rather than a number in a field. */
export const AUTONOMY_LEVELS: readonly AutonomyLevel[] = [
  {
    key: AUTONOMY_LEVEL.OBSERVE,
    name: AUTONOMY_LEVEL_NAME[AUTONOMY_LEVEL.OBSERVE],
    policyPackId: 'pack-observe',
    requires: [READINESS_ITEM.OWNER],
  },
  {
    key: AUTONOMY_LEVEL.SUGGEST,
    name: AUTONOMY_LEVEL_NAME[AUTONOMY_LEVEL.SUGGEST],
    policyPackId: 'pack-suggest',
    requires: [READINESS_ITEM.OWNER, READINESS_ITEM.AUDIT],
  },
  {
    key: AUTONOMY_LEVEL.ACT_REVERSIBLY,
    name: AUTONOMY_LEVEL_NAME[AUTONOMY_LEVEL.ACT_REVERSIBLY],
    policyPackId: 'pack-act-reversibly',
    requires: [READINESS_ITEM.OWNER, READINESS_ITEM.AUDIT, READINESS_ITEM.SEAM_COVERAGE],
  },
  {
    key: AUTONOMY_LEVEL.ACT_WITHIN_BOUNDS,
    name: AUTONOMY_LEVEL_NAME[AUTONOMY_LEVEL.ACT_WITHIN_BOUNDS],
    policyPackId: 'pack-act-within-bounds',
    requires: [
      READINESS_ITEM.OWNER,
      READINESS_ITEM.AUDIT,
      READINESS_ITEM.SEAM_COVERAGE,
      READINESS_ITEM.POLICY_COVERAGE,
      READINESS_ITEM.ESCALATION_PATH,
    ],
  },
  {
    key: AUTONOMY_LEVEL.ACT_AUTONOMOUSLY,
    name: AUTONOMY_LEVEL_NAME[AUTONOMY_LEVEL.ACT_AUTONOMOUSLY],
    policyPackId: 'pack-act-autonomously',
    requires: [
      READINESS_ITEM.OWNER,
      READINESS_ITEM.AUDIT,
      READINESS_ITEM.SEAM_COVERAGE,
      READINESS_ITEM.POLICY_COVERAGE,
      READINESS_ITEM.ESCALATION_PATH,
      READINESS_ITEM.BROKERED_CREDENTIALS,
      READINESS_ITEM.ROLLBACK,
    ],
  },
  {
    key: AUTONOMY_LEVEL.HOLD_DELEGATED_AUTHORITY,
    name: AUTONOMY_LEVEL_NAME[AUTONOMY_LEVEL.HOLD_DELEGATED_AUTHORITY],
    policyPackId: 'pack-hold-delegated-authority',
    requires: Object.values(READINESS_ITEM),
  },
];

export interface ReadinessDeps {
  identities: IdentityStore;
  seams: SeamStore;
  delegations: DelegationService;
  learn: LearnService;
  rules: () => Policy[];
  /** Whether anything has been audited for this agent at all. */
  hasAudit: (agentId: string) => Promise<boolean>;
  /** Whether any lease has ever been minted for it, rather than a key handed over. */
  hasBrokeredCredentials: (agentId: string) => Promise<boolean>;
}

/**
 * Every item is a query against something already stored, so the answer cannot be
 * aspirational and nobody can tick it. An item nothing answers yet is unknown, which
 * is not a pass: a readiness checklist over stores that do not exist is a questionnaire.
 */
export class ReadinessService {
  constructor(private readonly deps: ReadinessDeps) {}

  async assess(agentId: string, level: AutonomyLevelKey): Promise<Readiness | null> {
    const agent = await this.deps.identities.findById(agentId);
    if (agent === null) return null;
    const definition = AUTONOMY_LEVELS.find((each) => each.key === level);
    if (definition === undefined) return null;
    return assessReadiness(agentId, definition, await this.items(agent));
  }

  /** The highest level this agent is ready for right now, which may be none. */
  async highestReady(agentId: string): Promise<AutonomyLevelKey | null> {
    let highest: AutonomyLevelKey | null = null;
    for (const level of AUTONOMY_LEVELS) {
      const readiness = await this.assess(agentId, level.key);
      if (readiness === null || !readiness.ready) break;
      highest = level.key;
    }
    return highest;
  }

  private async items(agent: AgentIdentity): Promise<ReadinessItem[]> {
    const seams = await this.deps.seams.listByAgent(agent.id);
    const enforcing = seams.filter((seam) => seam.mode === ENFORCEMENT_MODE.ENFORCE);
    const naming = this.deps.rules().filter((policy) => hasApprovers(policy));

    return [
      item(
        READINESS_ITEM.OWNER,
        'identity store: agent.owner is set',
        agent.owner !== undefined,
        'nobody answers for this agent',
        'memnox agents assign <id> --owner <person>',
      ),
      item(
        READINESS_ITEM.AUDIT,
        'audit log: at least one decision for this agent',
        await this.deps.hasAudit(agent.id),
        'nothing it did has been recorded',
        'run it once under the runtime',
      ),
      item(
        READINESS_ITEM.SEAM_COVERAGE,
        'seam store: every installed seam is enforcing',
        seams.length > 0 && enforcing.length === seams.length,
        seams.length === 0
          ? 'no seam watches it'
          : 'a seam is installed but not enforcing',
        'memnox harden --apply',
      ),
      item(
        READINESS_ITEM.POLICY_COVERAGE,
        'policy set: a rule names actions this agent takes',
        this.deps.rules().length > 0,
        'no rule covers anything it does',
        'memnox learn --out memnox.proposed.yaml',
      ),
      item(
        READINESS_ITEM.ESCALATION_PATH,
        'policy set: some rule names an approver',
        naming.length > 0,
        'nothing escalates to a person',
        'add approvers to a rule',
      ),
      item(
        READINESS_ITEM.BROKERED_CREDENTIALS,
        'lease store: a lease has been minted for this agent',
        await this.deps.hasBrokeredCredentials(agent.id),
        'it holds keys rather than leases',
        'issue capabilities instead of secrets',
      ),
      item(
        READINESS_ITEM.ROLLBACK,
        'audit log: an execution outcome was reported',
        await this.deps.hasAudit(agent.id),
        'nothing it did reported an outcome, so nothing can be undone',
        'use guarded execution',
      ),
    ];
  }
}

function hasApprovers(policy: Policy): boolean {
  const approvers = policy.decision.approvers;
  return approvers !== undefined && approvers.length > 0;
}

function item(
  key: ReadinessItem['key'],
  query: string,
  met: boolean,
  blocker: string,
  remediation: string,
): ReadinessItem {
  if (met) return { key, query, status: READINESS_STATUS.MET };
  return { key, query, status: READINESS_STATUS.UNMET, blocker, remediation };
}
