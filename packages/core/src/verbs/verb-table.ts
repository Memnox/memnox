import { TOOL_CLASS, type ToolClass } from '../discovery/classify';

/**
 * What one authenticated CLI can actually do, argv pattern by argv pattern. This is
 * the substance behind every screen that turns `~/.aws/credentials` into "can modify
 * infra in 2 accounts": a credential file is a fact, a verb is what somebody repeats
 * to a colleague.
 */

/** Annotations that ride alongside the class rather than replacing it. */
export const VERB_TAG = {
  /** Touches something named like production. A guess from a name, and printed as one. */
  PRODUCTION: 'production',
  /** Reads or writes a credential. Worth asking about even when it is only a read. */
  SECRETS: 'secrets',
} as const;

export type VerbTag = (typeof VERB_TAG)[keyof typeof VERB_TAG];

export interface Verb {
  /** An argv pattern: literal words, `*` for one argument, `**` for the rest. */
  match: string;
  class: ToolClass;
  tags?: VerbTag[];
  /** Shown in `explain` and in the timeline, e.g. "preview deploy". */
  note?: string;
  /** What to do instead when a rule denies this. Never invented at refusal time. */
  alternative?: string;
}

export interface VerbTable {
  name: string;
  /** Files or environment variables that make this CLI authenticated. */
  credential: string[];
  /** The sentence a scan prints when this CLI is logged in. */
  headline: string;
  verbs: Verb[];
}

export interface VerbMatch {
  verb: Verb;
  /** The pattern that matched, so a report can say why. */
  pattern: string;
}

/**
 * Longest literal prefix wins, so `deploy --prod` beats `deploy`. Without this the
 * first-listed pattern would decide, and a table's ordering would quietly become a
 * security control nobody reviewed.
 */
function specificity(pattern: string): number {
  return (
    pattern
      .split(/\s+/)
      .filter((word) => word !== '*' && word !== '**')
      // A prefix like `delete-**` is more specific than a bare word but less than a literal.
      .reduce((total, word) => total + (word.endsWith('*') ? 1 : 2), 0)
  );
}

/** `delete-**` matches `delete-user`; `*` matches one argument; `**` matches the rest. */
function wordMatches(word: string, argument: string | undefined): boolean {
  if (argument === undefined) return false;
  if (!word.endsWith('*')) return argument === word;
  const prefix = word.replace(/\*+$/, '');
  return argument.startsWith(prefix);
}

function matchesPattern(pattern: string, argv: readonly string[]): boolean {
  const words = pattern.split(/\s+/).filter((word) => word !== '');
  let index = 0;

  for (const word of words) {
    if (word === '**') return true;
    if (word === '*') {
      if (index >= argv.length) return false;
      index += 1;
      continue;
    }
    // A flag may appear anywhere after the subcommand, which is how people type them.
    if (word.startsWith('-')) {
      if (!argv.includes(word)) return false;
      continue;
    }
    if (!wordMatches(word, argv[index])) return false;
    index += 1;
  }
  return true;
}

/**
 * How many argv slots a pattern's own words consume, so a caller can tell the verb
 * apart from what it was aimed at. Flags consume none: they may appear anywhere.
 */
function consumedBy(pattern: string, argv: readonly string[]): number {
  let index = 0;
  for (const word of pattern.split(/\s+/).filter((each) => each !== '')) {
    if (word === '**') break;
    if (word.startsWith('-')) continue;
    if (index >= argv.length) break;
    index += 1;
  }
  return index;
}

/**
 * What the command was aimed at: the last positional argument the verb did not eat.
 *
 * The last, not the first, because that is where CLI grammar puts the object —
 * `git push origin main`, `aws s3 rm s3://bucket/key`, `kubectl delete pod api-7`.
 * Taking the first returned the subcommand itself, so `target` was `push` on every
 * push and no rule scoped with `targets` could ever match. Last is also what survives
 * a flag carrying a value, since that value sits before the object rather than after.
 */
export function targetIn(verb: Verb, argv: readonly string[]): string | undefined {
  const positional = argv
    .slice(consumedBy(verb.match, argv))
    .filter((argument) => !argument.startsWith('-'));
  return positional[positional.length - 1];
}

/** Null when nothing in the table covers this command — which is `unknown`, not safe. */
export function matchVerb(table: VerbTable, argv: readonly string[]): VerbMatch | null {
  const candidates = table.verbs
    .filter((verb) => matchesPattern(verb.match, argv))
    .sort((a, b) => specificity(b.match) - specificity(a.match));

  const best = candidates[0];
  return best === undefined ? null : { verb: best, pattern: best.match };
}

/**
 * An unmatched command is reported as unknown and allowed. Blocking every unrecognised
 * subcommand would break the first real week; calling it safe would be the lie. It is
 * counted, and the scan says how many there were.
 */
export const UNKNOWN_VERB: Verb = {
  match: '**',
  class: TOOL_CLASS.UNKNOWN,
  note: 'no verb table entry covers this',
};

export function classOf(table: VerbTable, argv: readonly string[]): Verb {
  const matched = matchVerb(table, argv);
  return matched === null ? UNKNOWN_VERB : matched.verb;
}

/** Every verb that changes something outside this machine, for the scan's headline. */
export function externalStateVerbs(table: VerbTable): Verb[] {
  return table.verbs.filter(
    (verb) =>
      verb.class === TOOL_CLASS.WRITE ||
      verb.class === TOOL_CLASS.DESTRUCTIVE ||
      verb.class === TOOL_CLASS.COMMUNICATION,
  );
}

export function destructiveVerbs(table: VerbTable): Verb[] {
  return table.verbs.filter((verb) => verb.class === TOOL_CLASS.DESTRUCTIVE);
}

/**
 * The single action name for a verb, used by the scan, `explain`, `protect`, the
 * interceptor and `policy test`. One function, because a rule written from one screen
 * that failed to match at another would be a gate nobody could trust.
 */
export function verbAction(cli: string, verb: Verb): string {
  /* Flags stay in the name. `push --force` and `push origin main` are different
     actions, and collapsing them would make a rule about force-pushing deny every
     push — which is how a gate stops being used. */
  const words = verb.match
    .split(/\s+/)
    .filter((word) => word !== '' && !word.includes('*'))
    .map((word) => word.replace(/^-+/, '').toLowerCase());
  return words.length === 0 ? `${cli}.run` : `${cli}.${words.join('-')}`;
}

/** The action a command line resolves to, whether or not a table covers it. */
export function actionForCommand(
  cli: string,
  table: VerbTable,
  argv: readonly string[],
): string {
  const matched = matchVerb(table, argv);
  return matched === null ? `${cli}.unknown` : verbAction(cli, matched.verb);
}

export function hasTag(verb: Verb, tag: VerbTag): boolean {
  return (verb.tags ?? []).includes(tag);
}

/**
 * A command glob for one Memnox action, from the table the evaluator itself reads.
 *
 * `git.push-force` is our name for it; `git push --force*` is what a command-level deny
 * list has to match. Deriving it from the table means a rule compiled into somebody
 * else's config gates exactly what this product would have refused, rather than a
 * pattern written twice and drifting.
 */
export function commandGlobFor(
  action: string,
  tableFor: (name: string) => VerbTable | null,
): string | null {
  const dot = action.indexOf('.');
  if (dot <= 0) return null;
  const cli = action.slice(0, dot);
  const table = tableFor(cli);
  if (table === null) return null;

  const verb = table.verbs.find((each) => verbAction(cli, each) === action);
  if (verb === undefined) return null;
  // `**` means "and the rest", which is exactly what a trailing glob says.
  const pattern = verb.match.replace(/\s*\*\*\s*$/, '').trim();
  return pattern === '' ? `${cli}*` : `${cli} ${pattern}*`;
}
