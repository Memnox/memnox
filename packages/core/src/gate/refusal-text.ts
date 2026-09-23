import type { Alternative } from '../domain/decision';

/**
 * The way forward a refusal names, worded once
 * so every seam tells an agent the same thing.
 */
export function describeAlternative(alternative: Alternative): string {
  const resource = alternative.resource === undefined ? '' : ` ${alternative.resource}`;
  return `Instead: ${alternative.action}${resource}: ${alternative.note}`;
}
