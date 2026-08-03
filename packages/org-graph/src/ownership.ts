import { matchesPattern } from '@memnox/policy-engine';
import { STATED_KIND } from './org-graph.constants';
import { isBinding, type Stated } from './stated';

/** Who owns something, and the statement that makes them its owner. */
export interface Ownership {
  subject: string;
  owners: Array<{ name: string; throughDecision: string }>;
}

/**
 * Who answers for a subject.
 *
 * An empty answer is a real answer and the caller is meant to act on it:
 * nobody has been recorded as owning this, which is a reason to involve a
 * person rather than to pick the nearest plausible name. Nothing here guesses
 * an owner from a team name or a commit history.
 */
export function resolveOwnership(
  statements: readonly Stated[],
  subject: string,
  now: Date,
): Ownership {
  const owners = statements
    .filter((stated) => stated.kind === STATED_KIND.RESPONSIBILITY)
    .filter((stated) => isBinding(stated, now))
    // The statement's subject is the pattern: "production.*" owns every service
    // under it, so ownership is declared once rather than per resource.
    .filter((stated) => matchesPattern(stated.subject, subject))
    .filter((stated) => stated.object !== undefined)
    .map((stated) => ({ name: stated.object as string, throughDecision: stated.id }));

  return { subject, owners: dedupeByName(owners) };
}

/** Two statements can name the same owner; the first one recorded is the citation. */
function dedupeByName(
  owners: Array<{ name: string; throughDecision: string }>,
): Array<{ name: string; throughDecision: string }> {
  const seen = new Map<string, { name: string; throughDecision: string }>();
  for (const owner of owners) {
    if (!seen.has(owner.name)) seen.set(owner.name, owner);
  }
  return [...seen.values()];
}
