import type { ActionRequest } from './action-event';
import { DECISION_EFFECT } from '../constants/decision.constants';
import type { Decision, RuleRef } from './decision';
import { SCOPE_MATCH, type ScopeComparison } from './task';

/**
 * Why a verdict came out the way it did, in the words of the things that produced it,
 * so a refusal names the rule somebody can take to whoever set it.
 */
export const EXPLANATION_EVIDENCE = {
  RULE: 'rule',
  /** The request itself: what was asked, of what, by whom. */
  REQUEST: 'request',
  /** The task's declared scope, compared rather than judged. */
  SCOPE: 'scope',
} as const;

export type ExplanationEvidence =
  | { kind: 'rule'; rule: RuleRef }
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

/** Five lines, not a reasoning dump: source, resource, authority, rule, outcome. */
export const EXPLANATION_MAX_LINES = 5;

export interface ExplanationInput {
  decision: Decision;
  request: ActionRequest;
  agentName?: string;
  /** Set when the request fell outside what the task declared. */
  scope?: ScopeComparison;
}

/** Assembled from the same match the verdict came from; nothing here is inferred. */
export function buildExplanation(input: ExplanationInput): Explanation {
  const { decision } = input;
  const lines: ExplanationLine[] = [requestLine(input)];
  const scope = input.scope;
  if (scope !== undefined && scope.match === SCOPE_MATCH.OUT_OF_SCOPE) {
    lines.push(scopeLine(scope, `the task declared ${describeDeclared(scope)}`));
  }
  // Almost nothing explains an allow, so name the conditions that were met, from the record.
  if (decision.effect === DECISION_EFFECT.ALLOW)
    lines.push(...allowLines(decision, scope));
  if (decision.rule !== undefined) lines.push(ruleLine(decision, decision.rule));

  // The outcome is the line the reader came for, so the cap never drops it.
  return {
    decisionId: decision.eventId,
    lines: [...lines.slice(0, EXPLANATION_MAX_LINES - 1), outcomeLine(decision)],
  };
}

function requestLine(input: ExplanationInput): ExplanationLine {
  const { request } = input;
  const actor = input.agentName ?? 'the caller';
  const target = request.target === undefined ? '' : ` ${request.target}`;
  return {
    claim: `${actor} asked to ${request.action}${target}`,
    evidence: {
      kind: EXPLANATION_EVIDENCE.REQUEST,
      field: 'action',
      value: request.action,
    },
  };
}

function describeDeclared(scope: ScopeComparison): string {
  const dimension = scope.dimension ?? 'scope';
  const declared = (scope.declared ?? []).join(', ');
  return `${dimension} ${declared}, and this is ${scope.actual ?? 'something else'}`;
}

function scopeLine(scope: ScopeComparison, claim: string): ExplanationLine {
  return {
    claim,
    evidence: {
      kind: EXPLANATION_EVIDENCE.SCOPE,
      dimension: scope.dimension ?? 'scope',
      declared: scope.declared ?? [],
      actual: scope.actual ?? '',
    },
  };
}

function allowLines(
  decision: Decision,
  scope: ScopeComparison | undefined,
): ExplanationLine[] {
  const lines: ExplanationLine[] = [];
  if (scope !== undefined && scope.match === SCOPE_MATCH.IN_SCOPE) {
    lines.push(scopeLine(scope, 'the request was inside what the task declared'));
  }
  const approvalId = decision.approvalId;
  if (approvalId !== undefined) {
    lines.push({
      claim: `a person approved it (${approvalId})`,
      evidence: {
        kind: EXPLANATION_EVIDENCE.REQUEST,
        field: 'approvalId',
        value: approvalId,
      },
    });
  }
  return lines;
}

function ruleLine(decision: Decision, rule: RuleRef): ExplanationLine {
  return {
    claim: `rule ${rule.name} (v${rule.version}) matched: ${decision.reason}`,
    evidence: { kind: EXPLANATION_EVIDENCE.RULE, rule },
  };
}

function outcomeLine(decision: Decision): ExplanationLine {
  const verdict = `→ ${decision.effect.toUpperCase()}`;
  const alternative = decision.alternative;
  // Naming the action without the resource is the half that does not help: the agent
  // needs to know what to read, not merely that reading is still on the table.
  const instead =
    alternative === undefined
      ? undefined
      : [alternative.action, alternative.resource]
          .filter((part) => part !== undefined)
          .join(' ');
  return {
    claim:
      instead === undefined ? verdict : `${verdict}, and ${instead} is permitted instead`,
    evidence: {
      kind: EXPLANATION_EVIDENCE.REQUEST,
      field: 'effect',
      value: decision.effect,
    },
  };
}
