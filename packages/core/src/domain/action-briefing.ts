import type { Advisory } from './advisory';
import type { MatchedPolicy } from './decision';
import type { RiskAssessment } from './risk-assessment';
import type { ActionRequest } from './action-event';
import { DECISION_EFFECT, type DecisionEffect } from '../constants/decision.constants';
import type { RiskLevel } from '../constants/risk.constants';

/** Where a constraint was declared. Both are things the organization wrote down. */
export const CONSTRAINT_SOURCE = {
  POLICY: 'policy',
  ADVISOR: 'advisor',
} as const;

export type ConstraintSource = (typeof CONSTRAINT_SOURCE)[keyof typeof CONSTRAINT_SOURCE];

export interface BriefingConstraint {
  source: ConstraintSource;
  /** Policy name, or the advisor that raised it. */
  name: string;
  /** What this constraint would do on its own; absent for signal-only advisories. */
  effect?: DecisionEffect;
  /** The constraint in the words whoever declared it used. */
  statement: string;
  /** Who to ask when it requires approval. */
  approvers?: string[];
  /** True when no approval can satisfy it. */
  nonOverridable?: boolean;
}

/**
 * A security requirement for a class of work, from the baseline Memnox ships.
 *
 * The shape lives here; the table lives in `@memnox/content-shield`, which owns
 * security knowledge. Each entry is a rule looked up deterministically from the
 * action and target — no model, no inference, and never a judgement about code
 * that has already been written.
 */
export interface SecurityRequirement {
  /** Stable id so a requirement can be cited, suppressed, and diffed. */
  id: string;
  /** What this class of change must do. */
  requirement: string;
  /** What goes wrong when it does not. */
  why: string;
}

/**
 * What governs an action, answered before the action is attempted.
 *
 * This is the pre-flight counterpart to a decision: an agent asks "what applies
 * here?" and gets back the rules that already exist, rather than discovering
 * them by being refused.
 *
 * Two kinds of knowledge, kept separate on purpose. `constraints` are what this
 * organization declared, quoted verbatim. `security` is the baseline Memnox
 * ships for this class of work. Neither is generated, and the reader can always
 * tell which is which.
 */
export interface ActionBriefing {
  action: string;
  target?: string;
  environment?: string;
  riskLevel: RiskLevel;
  /** The verdict this action would receive right now. */
  wouldBe: DecisionEffect;
  constraints: BriefingConstraint[];
  security: SecurityRequirement[];
  /** Version of the shipped security baseline, so a briefing is reproducible. */
  securityBaseline?: string;
}

const UNCONSTRAINED =
  'No rule your organization wrote covers this action. That means nobody has ' +
  'ruled on it — not that it is a good idea.';

/**
 * The boundary, stated in the output itself: Memnox reports the constraints an
 * organization declared. It does not review a change or advise how to write one.
 */
const SCOPE_NOTE =
  'None of this is a review of your code — Memnox has not read it. The rules ' +
  'above are your organization’s; the checklist ships with Memnox.';

/** Each heading says what the section does to you, because the two differ. */
const RULES_HEADING = 'Rules that apply — these decide whether this proceeds:';
const SECURITY_HEADING = 'Not enforced, but worth checking for this kind of change';

export interface SecurityBaseline {
  requirements: SecurityRequirement[];
  version: string;
}

export function buildActionBriefing(
  request: ActionRequest,
  assessment: RiskAssessment,
  security?: SecurityBaseline,
): ActionBriefing {
  return {
    action: request.action,
    ...(request.target === undefined ? {} : { target: request.target }),
    ...(request.environment === undefined ? {} : { environment: request.environment }),
    riskLevel: assessment.riskLevel,
    wouldBe: assessment.effect,
    constraints: [
      ...assessment.matchedPolicies.map(fromPolicy),
      ...assessment.advisories.map(fromAdvisory),
    ],
    security: security === undefined ? [] : security.requirements,
    ...(security === undefined ? {} : { securityBaseline: security.version }),
  };
}

function fromPolicy(policy: MatchedPolicy): BriefingConstraint {
  return {
    source: CONSTRAINT_SOURCE.POLICY,
    name: policy.name,
    effect: policy.effect,
    statement: policy.reason ?? `policy "${policy.name}" applies`,
    ...(policy.approvers === undefined ? {} : { approvers: policy.approvers }),
  };
}

function fromAdvisory(advisory: Advisory): BriefingConstraint {
  return {
    source: CONSTRAINT_SOURCE.ADVISOR,
    name: advisory.source,
    ...(advisory.escalateTo === undefined ? {} : { effect: advisory.escalateTo }),
    statement: advisory.reason,
    ...(advisory.approvers === undefined ? {} : { approvers: advisory.approvers }),
    ...(advisory.nonOverridable === true ? { nonOverridable: true } : {}),
  };
}

const VERDICT_LABEL: Record<DecisionEffect, string> = {
  [DECISION_EFFECT.ALLOW]: 'be allowed',
  [DECISION_EFFECT.REDACT]: 'proceed only with its sensitive content masked',
  [DECISION_EFFECT.BLOCK]: 'be BLOCKED',
  [DECISION_EFFECT.REQUIRE_APPROVAL]: 'need human approval before it proceeds',
};

/** "advisor" names a Memnox internal; "signal" says what the reader is looking at. */
const SOURCE_LABEL: Record<ConstraintSource, string> = {
  [CONSTRAINT_SOURCE.POLICY]: 'your policy',
  [CONSTRAINT_SOURCE.ADVISOR]: 'signal',
};

/** What one constraint does on its own, in words rather than the stored enum. */
const CONSTRAINT_EFFECT_LABEL: Record<DecisionEffect, string> = {
  [DECISION_EFFECT.ALLOW]: 'allows',
  [DECISION_EFFECT.REDACT]: 'masks sensitive content',
  [DECISION_EFFECT.BLOCK]: 'blocks',
  [DECISION_EFFECT.REQUIRE_APPROVAL]: 'requires approval',
};

/**
 * Fixed, never the terminal's width: the same briefing has to render byte for
 * byte the same everywhere, or it can no longer be cached or diffed.
 */
const WRAP_COLUMNS = 78;
const BULLET = '  - ';
const DETAIL = '      ';

/**
 * The briefing as plain text an agent can put in its context before it works.
 * Deterministic — same briefing, same words, so it is safe to cache and diff.
 */
export function renderActionBriefing(briefing: ActionBriefing): string {
  const subject = [briefing.action, briefing.target].filter(Boolean).join(' ');
  const scope = briefing.environment === undefined ? '' : ` in ${briefing.environment}`;
  const lines = [
    `Memnox constraints for "${subject}"${scope}`,
    `This action would ${VERDICT_LABEL[briefing.wouldBe]} (risk: ${briefing.riskLevel}).`,
  ];
  const next = describeNextStep(briefing);
  if (next !== undefined) lines.push(...wrapped(next, ''));
  lines.push('');

  if (briefing.constraints.length === 0) {
    lines.push(...wrapped(UNCONSTRAINED, ''));
    appendSecurity(lines, briefing);
    appendScopeNote(lines);
    return lines.join('\n');
  }

  lines.push(RULES_HEADING);
  for (const constraint of briefing.constraints) {
    lines.push(`${BULLET}${constraint.name} — ${describeEffect(constraint)}`);
    lines.push(...wrapped(constraint.statement, DETAIL));
    if (constraint.approvers !== undefined && constraint.approvers.length > 0) {
      lines.push(`${DETAIL}approvers: ${constraint.approvers.join(', ')}`);
    }
  }
  appendSecurity(lines, briefing);
  appendScopeNote(lines);
  return lines.join('\n');
}

/**
 * Listed after the declared rules: an organization's own words come first. The
 * id leads each entry because it is what a reader cites or suppresses it by,
 * and the baseline version is stated once so the list can be reproduced.
 */
function appendSecurity(lines: string[], briefing: ActionBriefing): void {
  if (briefing.security.length === 0) return;
  const stamp =
    briefing.securityBaseline === undefined
      ? ''
      : ` (baseline ${briefing.securityBaseline})`;
  lines.push('', `${SECURITY_HEADING}${stamp}:`);
  for (const requirement of briefing.security) {
    lines.push(`${BULLET}${requirement.id}`);
    lines.push(...wrapped(requirement.requirement, DETAIL));
    lines.push(...wrapped(`why: ${requirement.why}`, DETAIL));
  }
}

function appendScopeNote(lines: string[]): void {
  lines.push('', ...wrapped(SCOPE_NOTE, ''));
}

/**
 * Where to go next, derived from the verdict rather than invented: a reader who
 * learns they are stopped still has to be told by whom.
 */
function describeNextStep(briefing: ActionBriefing): string | undefined {
  if (briefing.wouldBe === DECISION_EFFECT.BLOCK) {
    const sealed = briefing.constraints.some((c) => c.nonOverridable === true);
    return sealed
      ? 'Next: no approval can satisfy this — it will not proceed as described.'
      : 'Next: this will not proceed until the rule above no longer applies.';
  }
  if (briefing.wouldBe !== DECISION_EFFECT.REQUIRE_APPROVAL) return undefined;
  const approvers = approversOf(briefing);
  return approvers.length === 0
    ? 'Next: a human has to approve this before it proceeds.'
    : `Next: ask ${approvers.join(', ')} to approve before this proceeds.`;
}

/** First-seen order, so the same briefing always names approvers the same way. */
function approversOf(briefing: ActionBriefing): string[] {
  const seen: string[] = [];
  for (const constraint of briefing.constraints) {
    if (constraint.approvers === undefined) continue;
    for (const approver of constraint.approvers) {
      if (!seen.includes(approver)) seen.push(approver);
    }
  }
  return seen;
}

/**
 * Source is part of the label, not a section: a reader has to be able to tell a
 * rule this organization declared from a signal an advisor raised, and grouping
 * them under one heading loses exactly that.
 */
function describeEffect(constraint: BriefingConstraint): string {
  const source = SOURCE_LABEL[constraint.source];
  if (constraint.effect === undefined) return `${source}, no effect on its own`;
  const label = CONSTRAINT_EFFECT_LABEL[constraint.effect];
  if (constraint.nonOverridable === true) return `${source}, ${label} (no override)`;
  return `${source}, ${label}`;
}

/** Greedy wrap at a fixed column; a word longer than the column keeps its own line. */
function wrapped(text: string, indent: string): string[] {
  const width = WRAP_COLUMNS - indent.length;
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (word.length === 0) continue;
    if (line.length === 0) {
      line = word;
      continue;
    }
    if (line.length + 1 + word.length > width) {
      lines.push(indent + line);
      line = word;
      continue;
    }
    line = `${line} ${word}`;
  }
  if (line.length > 0) lines.push(indent + line);
  return lines;
}
