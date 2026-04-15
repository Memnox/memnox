const WILDCARD = '*';
/** Patterns come from policy files, so the set is bounded; the cap is a backstop. */
const MAX_CACHED_PATTERNS = 10_000;
const compiled = new Map<string, RegExp>();

function compile(pattern: string): RegExp {
  const cached = compiled.get(pattern);
  if (cached !== undefined) return cached;
  const escaped = pattern
    .toLowerCase()
    .split(WILDCARD)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  const expression = new RegExp(`^${escaped}$`);
  if (compiled.size < MAX_CACHED_PATTERNS) compiled.set(pattern, expression);
  return expression;
}

/**
 * Deterministic wildcard matching: "*" matches any sequence of characters,
 * including "." and "/" separators. Matching is case-insensitive.
 * "database.*" matches "database.delete"; "payment/*" matches "payment/api/refund.ts".
 */
export function matchesPattern(pattern: string, value: string): boolean {
  return compile(pattern).test(value.toLowerCase());
}

/** True when any pattern matches. An undefined pattern list matches everything. */
export function matchesAny(
  patterns: string[] | undefined,
  value: string | undefined,
): boolean {
  if (!patterns || patterns.length === 0) return true;
  if (value === undefined) return patterns.includes(WILDCARD);
  return patterns.some((pattern) => matchesPattern(pattern, value));
}
