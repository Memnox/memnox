/**
 * How a rule's pattern is matched against an action, a path or a name. One matcher for
 * every domain, because a second would be a rule that fires on one screen and not at the seam.
 */
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
  // `s` so a wildcard spans a newline too: an argument is matched unnormalized,
  // and without it a multi-line command slipped past the rule naming it.
  const expression = new RegExp(`^${escaped}$`, 's');
  if (compiled.size < MAX_CACHED_PATTERNS) compiled.set(pattern, expression);
  return expression;
}

/** Case-insensitive wildcards; "*" spans ".", "/" and line breaks too. */
export function matchesPattern(pattern: string, value: string): boolean {
  return compile(pattern).test(value.toLowerCase());
}

/** A pattern that takes matches back out, as `!api.stripe.com` or `!{workspace}/**`. */
const EXCLUDE = '!';

/**
 * True when any pattern matches and no `!` pattern does. An undefined list matches
 * everything, and so does one of exclusions only, since it names what it leaves out.
 * A value nobody reported cannot be shown to be excluded, so the rule still applies.
 */
export function matchesAny(
  patterns: readonly string[] | undefined,
  value: string | undefined,
): boolean {
  if (!patterns || patterns.length === 0) return true;
  const excluded = patterns.filter((pattern) => pattern.startsWith(EXCLUDE));
  const included = patterns.filter((pattern) => !pattern.startsWith(EXCLUDE));
  if (value === undefined) return included.length === 0 || included.includes(WILDCARD);
  if (excluded.some((pattern) => matchesPattern(pattern.slice(EXCLUDE.length), value))) {
    return false;
  }
  return (
    included.length === 0 || included.some((pattern) => matchesPattern(pattern, value))
  );
}

/** Stands for the directory the agent is working in, so a rule can say inside or outside it. */
export const WORKSPACE_TOKEN = '{workspace}';

// Never a path, so a pattern about a workspace nobody reported matches and excludes nothing.
const NO_WORKSPACE = '\u0000no-workspace';

export function withWorkspace(
  patterns: readonly string[] | undefined,
  workingDirectory: string | undefined,
): readonly string[] | undefined {
  if (
    patterns === undefined ||
    !patterns.some((each) => each.includes(WORKSPACE_TOKEN))
  ) {
    return patterns;
  }
  const root =
    workingDirectory === undefined ? NO_WORKSPACE : workingDirectory.replace(/\/+$/, '');
  return patterns.map((pattern) => pattern.split(WORKSPACE_TOKEN).join(root));
}
