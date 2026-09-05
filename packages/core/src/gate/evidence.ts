import { describeOverlay, inForce, type Overlay } from '../policy/overlay';
import type { MatchedPolicy } from '../domain/decision';

/**
 * What produced a verdict, in the words of the things that produced it. A refusal that
 * says only "denied by policy" is a refusal somebody argues with the tool about; one
 * that names the freeze, the rule and the file is a refusal they argue with the person
 * who set it — which is the argument that should be happening.
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
  for (const policy of input.matched) {
    const why = policy.reason === undefined ? '' : ` — ${policy.reason}`;
    // An observed rule matched without deciding, and saying so stops a false alarm.
    const mode = policy.observed === true ? ' (observing, decided nothing)' : '';
    lines.push({ source: 'rule', detail: `${policy.name}${why}${mode}` });
  }
  for (const detail of input.repository ?? []) {
    lines.push({ source: 'repo', detail });
  }
  return lines;
}

/** Aligned, so the sources read as a column and the details as a story. */
export function renderEvidence(lines: readonly EvidenceLine[]): string[] {
  if (lines.length === 0) return [];
  const width = Math.max(...lines.map((line) => line.source.length));
  return lines.map((line) => `    ${line.source.padEnd(width)}  ${line.detail}`);
}
