import type { DecisionEffect, RateLimitSpec } from '@memnox/core';
import type { TimeWindow } from './time-window';

/** All match fields are lists of wildcard patterns; omitted fields match anything. */
export interface PolicyMatch {
  actions: string[];
  targets?: string[];
  environments?: string[];
  agents?: string[];
  /**
   * The person the agent is acting for, e.g. `["cfo@acme.com"]`.
   *
   * Distinct from `agents`: one rule can govern every agent that acts for the
   * CFO without naming any of them, which is how a delegation survives the
   * agent being replaced.
   */
  principals?: string[];
  models?: string[];
  providers?: string[];
  dataClassifications?: string[];
  jurisdictions?: string[];
  /** Directory the agent is working in, e.g. "/srv/checkout/*". */
  workingDirectories?: string[];
  /** Source control branch, e.g. "main", "release/*". */
  branches?: string[];
  /**
   * Patterns per named argument of the call itself — `{ command: ["*rm -rf*"] }`.
   * Every named argument must match (a rule narrows as you add them); an argument
   * the call does not carry matches only the bare "*". Arguments are matched by
   * the in-process gate, which is the only place the raw payload exists.
   */
  arguments?: Record<string, string[]>;
  /**
   * The rule applies only to an action bigger than this, in the unit the action
   * counts in. "Refunds above a thousand need approval" is one rule with this
   * set, rather than a rule the gate cannot express at all.
   *
   * **An action that does not say how big it is matches.** It cannot prove it
   * is under the threshold, and a caller that omits the number must not thereby
   * escape the rule that the number exists for.
   */
  aboveAmount?: number;
  /** The policy applies only inside these recurring windows. */
  windows?: TimeWindow[];
}

/** Per-rule mode. A monitored rule matches and is recorded, but never decides. */
export const POLICY_MODE = {
  ENFORCE: 'enforce',
  MONITOR: 'monitor',
} as const;

export type PolicyMode = (typeof POLICY_MODE)[keyof typeof POLICY_MODE];

export const DEFAULT_POLICY_MODE: PolicyMode = POLICY_MODE.ENFORCE;

export interface PolicyDecision {
  effect: DecisionEffect;
  reason?: string;
  approvers?: string[];
  /** Distinct people required to approve; defaults to one. */
  minApprovals?: number;
  /**
   * "monitor" rolls this one rule out without enforcing it: the verdict is
   * recorded as withheld and the action proceeds. Defaults to "enforce".
   */
  mode?: PolicyMode;
  /**
   * Caps how often this rule may fire before it stops allowing. Counted by the
   * gateway per agent and rule, because a ceiling needs state and a clock and
   * the engine has neither.
   */
  rateLimit?: RateLimitSpec;
}

export interface Policy {
  name: string;
  description?: string;
  match: PolicyMatch;
  decision: PolicyDecision;
  /**
   * Governance unit this rule belongs to, inherited from the file that declared
   * it. Unset = every project, so a single-project deployment is unaffected.
   */
  project?: string;
}

export interface PolicyDocument {
  version: number;
  /**
   * The governance unit this file contributes rules to. Several repositories
   * may declare the same project — a frontend and a backend that both say
   * `project: acme-checkout` share one policy and memory scope, and their rule
   * sets compose under the existing most-restrictive-wins semantics.
   */
  project?: string;
  policies: Policy[];
}

export const POLICY_DOCUMENT_VERSION = 1;
