import type { ActionRequest } from './action-event';
import { CONTEXT_TRUST } from '../constants/context-trust.constants';
import { contextRefOf, type ContextRef } from './context-block';
import type { Decision, RuleRef } from './decision';
import { SCOPE_MATCH, type ScopeComparison } from './task';

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

/** Five lines, not a reasoning dump: source, resource, authority, rule, outcome. */
export const EXPLANATION_MAX_LINES = 5;

export interface ExplanationInput {
  decision: Decision;
  request: ActionRequest;
  agentName?: string;
  /** Set when the request fell outside what the task declared. */
  scope?: ScopeComparison;
}

/**
 * Assembled from the same match the verdict came from, so every line traces back to a
 * rule version or a context block. Nothing here is generated, summarised or inferred.
 */
export function buildExplanation(input: ExplanationInput): Explanation {
  const { decision, request } = input;
  const lines: ExplanationLine[] = [];

  const actor = input.agentName === undefined ? 'the caller' : input.agentName;
  const target = request.target === undefined ? '' : ` ${request.target}`;
  lines.push({
    claim: `${actor} asked to ${request.action}${target}`,
    evidence: {
      kind: EXPLANATION_EVIDENCE.REQUEST,
      field: 'action',
      value: request.action,
    },
  });

  const untrusted = (request.context ?? []).filter(
    (block) => block.trust !== CONTEXT_TRUST.TRUSTED,
  );
  for (const block of untrusted.slice(0, 1)) {
    lines.push({
      claim: `context from ${block.source} is ${block.trust}, so it is evidence and not instruction`,
      evidence: { kind: EXPLANATION_EVIDENCE.CONTEXT, context: contextRefOf(block) },
    });
  }

  const scope = input.scope;
  if (scope !== undefined && scope.match === SCOPE_MATCH.OUT_OF_SCOPE) {
    const dimension = scope.dimension === undefined ? 'scope' : scope.dimension;
    lines.push({
      claim: `the task declared ${dimension} ${(scope.declared ?? []).join(', ')}, and this is ${scope.actual ?? 'something else'}`,
      evidence: {
        kind: EXPLANATION_EVIDENCE.SCOPE,
        dimension,
        declared: scope.declared ?? [],
        actual: scope.actual ?? '',
      },
    });
  }

  const rule = decision.rule;
  if (rule !== undefined) {
    lines.push({
      claim: `rule ${rule.name} (v${rule.version}) matched: ${decision.reason}`,
      evidence: { kind: EXPLANATION_EVIDENCE.RULE, rule },
    });
  }

  const alternative = decision.alternative;
  const outcome =
    alternative === undefined
      ? `→ ${decision.effect.toUpperCase()}`
      : `→ ${decision.effect.toUpperCase()}, and ${alternative.action} is permitted instead`;
  lines.push({
    claim: outcome,
    evidence: {
      kind: EXPLANATION_EVIDENCE.REQUEST,
      field: 'effect',
      value: decision.effect,
    },
  });

  return { decisionId: decision.eventId, lines: lines.slice(0, EXPLANATION_MAX_LINES) };
}
