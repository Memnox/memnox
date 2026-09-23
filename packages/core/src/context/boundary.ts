/**
 * The short block an agent reads when its session starts: the mode, what the rules here
 * refuse and ask about, the boundary, any probation, and how a person answers. Deterministic,
 * bounded, and made of rule names and reasons only, so no secret can be in it.
 */
import { DECISION_EFFECT } from '../constants/decision.constants';
import {
  ENFORCEMENT_MODE,
  type EnforcementMode,
} from '../constants/enforcement.constants';
import type { Containment } from '../gate/containment';
import { POLICY_MODE, type Policy } from '../policy/policy';
import {
  MOST_BOUNDARY_CHARS,
  MOST_RULE_CHARS,
  MOST_RULES_PER_GROUP,
} from './context.constants';

export interface BoundaryInput {
  mode: EnforcementMode;
  /** The rules in force for this repository, already narrowed to it. */
  rules: readonly Policy[];
  containment: Containment | null;
}

/** The line every block ends on, so the agent knows a question is the person's to answer. */
export const HOW_TO_ANSWER =
  'When Memnox asks, the prompt puts the question to the person, who can say yes once or always; a refusal names what to use instead.';

const HEADERS: Readonly<Record<string, string>> = {
  [ENFORCEMENT_MODE.OBSERVE]:
    'Memnox is watching this session in observe mode: nothing is stopped, and what it would have asked about or refused is recorded.',
  [ENFORCEMENT_MODE.ADVISE]:
    'Memnox is watching this session in advise mode: nothing is stopped, and what it would have asked about or refused is said and recorded.',
  [ENFORCEMENT_MODE.ENFORCE]:
    'Memnox rules on this session in enforce mode: a rule that refuses stops the call, and one that asks puts the question to the person.',
};

const ELLIPSIS = '...';

/** The parts of the block, in the order they are shown. */
type Part = 'header' | 'deny' | 'ask' | 'boundary' | 'probation' | 'answer';

const SHOWN_ORDER: readonly Part[] = [
  'header',
  'deny',
  'ask',
  'boundary',
  'probation',
  'answer',
];

/** Which parts survive a tight budget first: the mode and how to answer before any rule. */
const KEPT_ORDER: readonly Part[] = [
  'header',
  'answer',
  'boundary',
  'probation',
  'deny',
  'ask',
];

/** The block, or empty in off mode, where nothing is ruled on and nothing is worth saying. */
export function boundaryContext(input: BoundaryInput): string {
  const header = HEADERS[input.mode];
  if (header === undefined) return '';
  const parts: Record<Part, string | null> = {
    header: `Memnox: ${header}`,
    deny: groupLine('Never run here', input.rules, DECISION_EFFECT.DENY),
    ask: groupLine('A person is asked first', input.rules, DECISION_EFFECT.ASK),
    boundary: boundaryLine(input.containment),
    probation: probationLine(input.containment),
    answer: HOW_TO_ANSWER,
  };
  const kept = keptWithin(parts, MOST_BOUNDARY_CHARS);
  return SHOWN_ORDER.filter((part) => kept.has(part))
    .map((part) => parts[part])
    .join('\n');
}

function keptWithin(parts: Record<Part, string | null>, budget: number): Set<Part> {
  const kept = new Set<Part>();
  let used = 0;
  for (const part of KEPT_ORDER) {
    const line = parts[part];
    // One for the newline each kept line is joined by.
    if (line === null || used + line.length + 1 > budget) continue;
    kept.add(part);
    used += line.length + 1;
  }
  return kept;
}

/** Rules of one effect, the first few named and the rest counted. Observed rules decide nothing. */
function groupLine(
  label: string,
  rules: readonly Policy[],
  effect: string,
): string | null {
  const named = [
    ...new Set(
      rules
        .filter(
          (rule) =>
            rule.decision.effect === effect && rule.decision.mode !== POLICY_MODE.OBSERVE,
        )
        .map(plainWords),
    ),
  ];
  if (named.length === 0) return null;
  const shown = named.slice(0, MOST_RULES_PER_GROUP);
  const more = named.length - shown.length;
  return `${label}: ${shown.join('; ')}${more > 0 ? `; and ${more} more` : ''}.`;
}

/** What a rule is about and why, in the rule's own words, clipped to one short line. */
function plainWords(rule: Policy): string {
  const actions = rule.match.actions.join(' or ');
  const targets = rule.match.targets;
  const on = targets === undefined ? '' : ` on ${targets.slice(0, 2).join(', ')}`;
  const reason = rule.decision.reason ?? rule.description;
  const said = `${actions}${on}${reason === undefined ? '' : ` (${reason})`}`;
  return said.length <= MOST_RULE_CHARS
    ? said
    : `${said.slice(0, MOST_RULE_CHARS - ELLIPSIS.length)}${ELLIPSIS}`;
}

function boundaryLine(containment: Containment | null): string | null {
  if (containment === null || containment.root === undefined) return null;
  return `Project boundary: ${containment.root}. A write outside it asks first.`;
}

function probationLine(containment: Containment | null): string | null {
  const probation = containment === null ? undefined : containment.probation;
  if (probation === undefined) return null;
  return `Probation: ${probation.name} is on probation until ${probation.until.slice(0, 10)}, so its writes and outward actions ask first.`;
}
