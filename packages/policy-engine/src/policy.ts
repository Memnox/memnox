import type { Alternative, DecisionEffect, RateLimitSpec } from '@memnox/core';
import type { ScopeMatch } from '@memnox/core';
import type { TimeWindow } from './time-window';

/** All match fields are lists of wildcard patterns; omitted fields match anything. */
export interface PolicyMatch {
  actions: string[];
  targets?: string[];
  environments?: string[];
  agents?: string[];
  /** Distinct from `agents`: a delegation survives the agent being replaced. */
  principals?: string[];
  models?: string[];
  providers?: string[];
  dataClassifications?: string[];
  jurisdictions?: string[];
  /** Directory the agent is working in, e.g. "/srv/checkout/*". */
  workingDirectories?: string[];
  /** Source control branch, e.g. "main", "release/*". */
  branches?: string[];
  /** Every named argument must match; matched only by the in-process gate. */
  arguments?: Record<string, string[]>;
  /** An action that does not state its size still matches — it cannot prove it is under. */
  aboveAmount?: number;
  /** The policy applies only inside these recurring windows. */
  windows?: TimeWindow[];
  /**
   * How the request sat against the task's declared scope. A comparison, never a
   * judgement: `out_of_scope` is a fact a rule matches on, exactly like an environment.
   */
  scope?: ScopeMatch[];
}

/** Per-rule mode. An observed rule matches and is recorded, but never decides. */
export const POLICY_MODE = {
  ENFORCE: 'enforce',
  OBSERVE: 'observe',
} as const;

export type PolicyMode = (typeof POLICY_MODE)[keyof typeof POLICY_MODE];

export const DEFAULT_POLICY_MODE: PolicyMode = POLICY_MODE.ENFORCE;

export interface PolicyDecision {
  effect: DecisionEffect;
  reason?: string;
  approvers?: string[];
  /** Distinct people required to approve; defaults to one. */
  minApprovals?: number;
  /** "observe" records the verdict as withheld and lets the action proceed. */
  mode?: PolicyMode;
  /** Counted by the gateway: a ceiling needs state and a clock, which the engine lacks. */
  rateLimit?: RateLimitSpec;
  /**
   * What the agent may do instead. Named by the rule that withholds, never invented,
   * which is what makes redirection reliable enough for an agent to take.
   */
  alternative?: Alternative;
}

export interface Policy {
  /** Stable across a rename, so an old decision still cites the rule it matched. */
  id?: string;
  name: string;
  description?: string;
  match: PolicyMatch;
  decision: PolicyDecision;
  /** Unset = every project, so a single-project deployment is unaffected. */
  project?: string;
}

export interface PolicyDocument {
  version: number;
  /** Repos declaring the same project share one policy and memory scope. */
  project?: string;
  policies: Policy[];
}

export const POLICY_DOCUMENT_VERSION = 1;
