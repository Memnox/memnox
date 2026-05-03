export const DECISION_ENFORCEMENT = {
  /** Recorded in the advisory trail only. */
  WARN: 'warn',
  REQUIRE_APPROVAL: 'require_approval',
  BLOCK: 'block',
} as const;

export type DecisionEnforcement =
  (typeof DECISION_ENFORCEMENT)[keyof typeof DECISION_ENFORCEMENT];

export const DECISION_STATUS = {
  ACTIVE: 'active',
  SUPERSEDED: 'superseded',
  RETIRED: 'retired',
} as const;

export type DecisionStatus = (typeof DECISION_STATUS)[keyof typeof DECISION_STATUS];

export const REVERSIBILITY_COST = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
} as const;

export type ReversibilityCost =
  (typeof REVERSIBILITY_COST)[keyof typeof REVERSIBILITY_COST];

/** Where a decision entered the system; feeds the source-authority table. */
export const DECISION_SOURCE_MANUAL = 'manual';

/**
 * A team decision captured as a machine-checkable constraint,
 * e.g. "Do not migrate the database before Q4" → actions: ["database.migrate"].
 * Decisions are reviewed and superseded, never silently expired.
 */
export interface DecisionRecord {
  id: string;
  title: string;
  /** The decision in the team's own words — shown when the constraint fires. */
  statement: string;
  owner: string;
  decidedAt: string;
  /** Wildcard patterns, same semantics as policies. Omitted fields match everything. */
  actions: string[];
  targets?: string[];
  environments?: string[];
  enforcement: DecisionEnforcement;
  /** Only "active" decisions enforce. Missing on pre-lifecycle records → active. */
  status?: DecisionStatus;
  /** Set when a newer decision replaces this one. */
  supersededById?: string;
  /** How expensive it is to reverse the decided course — context for reviewers. */
  reversibilityCost?: ReversibilityCost;
  /** Where the decision came from (manual, slack_message, github_pull_request, ...). */
  sourceType?: string;
  /** Permalink to the evidence: Slack thread, PR, meeting note. */
  sourceRef?: string;
  /** After this date the decision still enforces but is flagged as due for review. */
  reviewAfter?: string;
  /** Owning org/workspace; unset = single-tenant deployment. */
  orgId?: string;
}

export function isEnforcing(record: DecisionRecord): boolean {
  return (record.status ?? DECISION_STATUS.ACTIVE) === DECISION_STATUS.ACTIVE;
}

export interface DecisionStore {
  save(record: DecisionRecord): Promise<void>;
  list(): Promise<DecisionRecord[]>;
  remove(id: string): Promise<boolean>;
}
