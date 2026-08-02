import type { DecisionEffect } from '@memnox/core';
import type { TimeWindow } from './time-window';

/** All match fields are lists of wildcard patterns; omitted fields match anything. */
export interface PolicyMatch {
  actions: string[];
  targets?: string[];
  environments?: string[];
  agents?: string[];
  models?: string[];
  providers?: string[];
  dataClassifications?: string[];
  jurisdictions?: string[];
  /** The policy applies only inside these recurring windows. */
  windows?: TimeWindow[];
}

export interface PolicyDecision {
  effect: DecisionEffect;
  reason?: string;
  approvers?: string[];
  /** Distinct people required to approve; defaults to one. */
  minApprovals?: number;
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
