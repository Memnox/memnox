import type { Alternative } from '../domain/decision';
import { GENERATED_ALTERNATIVE_NOTE } from '../policy/domains';

/**
 * The way forward a refusal names, worded once
 * so every seam tells an agent the same thing.
 */
export function describeAlternative(alternative: Alternative): string {
  const resource = alternative.resource === undefined ? '' : ` ${alternative.resource}`;
  return `Instead: ${alternative.action}${resource}: ${alternative.note}`;
}

/**
 * The way forward for one command: the rule's own when it wrote one for this, and the
 * verb table's when the rule only said to ask somebody or named a whole family of actions.
 */
export function alternativeFor(
  fromRule: Alternative | undefined,
  fromTable: string | undefined,
  action: string,
): Alternative | undefined {
  if (fromTable === undefined) return fromRule;
  const generic =
    fromRule === undefined ||
    fromRule.action.includes('*') ||
    fromRule.note === GENERATED_ALTERNATIVE_NOTE;
  return generic ? { action, note: fromTable } : fromRule;
}

/** The environment a refused command named, said as it was named and never as a guess. */
export function describeEnvironment(environment: string | undefined): string | null {
  return environment === undefined ? null : `Environment: ${environment}.`;
}
