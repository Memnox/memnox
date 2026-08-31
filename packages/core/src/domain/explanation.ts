import type { ContextRef } from './context-block';
import type { RuleRef } from './decision';

export const EXPLANATION_EVIDENCE = {
  RULE: 'rule',
  CONTEXT: 'context',
  /** The request itself: what was asked, of what, by whom. */
  REQUEST: 'request',
  /** The task's declared scope, compared rather than judged. */
  SCOPE: 'scope',
} as const;

export type ExplanationEvidenceKind =
  (typeof EXPLANATION_EVIDENCE)[keyof typeof EXPLANATION_EVIDENCE];

export type ExplanationEvidence =
  | { kind: 'rule'; rule: RuleRef }
  | { kind: 'context'; context: ContextRef }
  | { kind: 'request'; field: string; value: string }
  | { kind: 'scope'; dimension: string; declared: readonly string[]; actual: string };

export interface ExplanationLine {
  claim: string;
  evidence: ExplanationEvidence;
}

/**
 * Built from the match and stored beside the decision, so it reads the same a year later.
 * An explanation regenerated afterwards by a model is a plausible story about a decision,
 * which is worse than none.
 */
export interface Explanation {
  decisionId: string;
  lines: ExplanationLine[];
}

export interface ExplanationStore {
  save(explanation: Explanation): Promise<void>;
  findByDecision(decisionId: string): Promise<Explanation | null>;
}
