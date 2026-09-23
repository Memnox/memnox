import { describeOverlay, inForce, type Overlay } from '../policy/overlay';
import type { MatchedPolicy } from '../domain/decision';

/**
 * What produced a verdict, in the words of the things that produced it, so a refusal
 * is taken to whoever set the rule rather than argued with the tool.
 */

export interface EvidenceLine {
  /** Where it came from, in one word: state, rule, repository. */
  source: string;
  detail: string;
}

export interface EvidenceInput {
  matched: readonly MatchedPolicy[];
  overlays?: readonly Overlay[];
  moment: string;
  /** Lines the repository already answered for, e.g. branch protection or CODEOWNERS. */
  repository?: readonly string[];
}

/** State first: it is the fact most likely to be newer than everything else on screen. */
export function evidenceFor(input: EvidenceInput): EvidenceLine[] {
  const lines: EvidenceLine[] = [];

  for (const overlay of inForce(input.overlays ?? [], input.moment)) {
    lines.push({ source: 'state', detail: describeOverlay(overlay, input.moment) });
  }
  for (const policy of distinctRules(input.matched)) {
    const why = policy.reason === undefined ? '' : `: ${policy.reason}`;
    // An observed rule matched without deciding, and saying so stops a false alarm.
    const mode = policy.observed === true ? ' (observing, decided nothing)' : '';
    lines.push({ source: 'rule', detail: `${policy.name}${why}${mode}` });
  }
  for (const detail of input.repository ?? []) {
    lines.push({ source: 'repo', detail });
  }
  return lines;
}

/** A team rule arrives named by its content hash, which tells a person nothing. */
const PUBLISHED_RULE_ID = /^[0-9a-f]{32}$/;
const TEAM_RULE = 'team rule';

/**
 * One line per thing a rule says, because the same answer loaded from a repository, the
 * home file and the team bundle is one rule to the person reading it, not five.
 */
function distinctRules(matched: readonly MatchedPolicy[]): MatchedPolicy[] {
  const byMeaning = new Map<string, MatchedPolicy>();
  for (const policy of matched) {
    const named = PUBLISHED_RULE_ID.test(policy.name)
      ? { ...policy, name: TEAM_RULE }
      : policy;
    const key = `${named.effect}\n${named.reason ?? ''}\n${named.observed === true}`;
    const seen = byMeaning.get(key);
    // A name somebody wrote beats the stand-in for one nobody did.
    if (seen === undefined || seen.name === TEAM_RULE) byMeaning.set(key, named);
  }
  return [...byMeaning.values()];
}

/** Aligned, so the sources read as a column and the details as a story. */
export function renderEvidence(lines: readonly EvidenceLine[]): string[] {
  if (lines.length === 0) return [];
  const width = Math.max(...lines.map((line) => line.source.length));
  return lines.map((line) => `    ${line.source.padEnd(width)}  ${line.detail}`);
}
