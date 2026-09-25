/**
 * What one authenticated CLI can do, argv pattern by argv pattern: what turns
 * `~/.aws/credentials` into what an agent could actually do with it.
 */
import { changesExternalState, TOOL_CLASS, type ToolClass } from '../discovery/classify';

/** Annotations that ride alongside the class rather than replacing it. */
export const VERB_TAG = {
  /** Touches something named like production. A guess from a name, and printed as one. */
  PRODUCTION: 'production',
  /** Reads or writes a credential. Worth asking about even when it is only a read. */
  SECRETS: 'secrets',
} as const;

export type VerbTag = (typeof VERB_TAG)[keyof typeof VERB_TAG];

export interface Verb {
  /**
   * An argv pattern: literal words, `*` for one argument, `**` for the rest, and `$` for
   * nothing after, so `branch $` is the listing and not `branch feature`.
   */
  match: string;
  /** The action's own name, where the pattern alone would give two verbs one name. */
  name?: string;
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
  /**
   * Flags that may come before the verb and take a value, as `kubectl --context prod delete`.
   * An entry ending in `=` takes its value joined, as terraform's `-chdir=dir`.
   */
  globalFlags?: string[];
  /** Flags that may come before the verb and take no value. */
  globalSwitches?: string[];
  /** Flags whose value is an HTTP method, which may be run on as `-XPOST` or lowercased. */
  methodFlags?: string[];
}

export interface VerbMatch {
  verb: Verb;
  /** The pattern that matched, so a report can say why. */
  pattern: string;
}

/**
 * Longest literal prefix wins, so `deploy --prod` beats `deploy` rather than a table's
 * ordering quietly becoming a security control nobody reviewed.
 */
function specificity(pattern: string): number {
  return (
    pattern
      .split(/\s+/)
      .filter((word) => word !== '*' && word !== '**')
      // Nothing after is a constraint, so it outranks the same words that allow more.
      .map((word) => (word === '$' ? '$*' : word))
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

/**
 * Where a pattern's flag sits in argv, or -1. A short flag matches the letters of a cluster,
 * such as `-xfd`; long flags stay exact, because `--force-with-lease` is not `--force`.
 */
function flagIndexIn(flag: string, argv: readonly string[]): number {
  if (flag.startsWith('--')) return argv.indexOf(flag);

  const wanted = [...flag.slice(1)];
  return argv.findIndex(
    (argument) =>
      /^-[A-Za-z]+$/.test(argument) &&
      wanted.every((letter) => argument.includes(letter)),
  );
}

function matchesPattern(pattern: string, argv: readonly string[]): boolean {
  const words = pattern.split(/\s+/).filter((word) => word !== '');
  let index = 0;
  // Where the flag just matched sits, so the next word is read as its value, which is
  // how `api -X DELETE **` matches `gh api -X DELETE`.
  let valueOf = -1;

  for (const word of words) {
    if (word === '**') return true;
    if (word === '$') return index >= argv.length;
    if (word === '*') {
      if (index >= argv.length) return false;
      index += 1;
      valueOf = -1;
      continue;
    }
    // A flag may appear anywhere after the subcommand, which is how people type them.
    if (word.startsWith('-')) {
      const at = flagIndexIn(word, argv);
      if (at === -1) return false;
      valueOf = at;
      continue;
    }
    if (valueOf !== -1) {
      if (!wordMatches(word, argv[valueOf + 1])) return false;
      valueOf = -1;
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
    if (word === '**' || word === '$') break;
    if (word.startsWith('-')) continue;
    if (index >= argv.length) break;
    index += 1;
  }
  return index;
}

/**
 * What the command was aimed at: the last positional argument the verb did not eat, since
 * CLI grammar puts the object last, as in `aws s3 rm s3://bucket/key`.
 */
export function targetIn(verb: Verb, argv: readonly string[]): string | undefined {
  const positional = argv
    .slice(consumedBy(verb.match, argv))
    .filter((argument) => !argument.startsWith('-'));
  return positional[positional.length - 1];
}

/**
 * argv as a table reads it: `--flag=value` split in two, a method flag's value run on or
 * lowercased made plain, and the CLI's own flags before the verb taken out, so
 * `kubectl -n prod delete pod x` is a delete rather than an unknown.
 */
export function verbArgv(table: VerbTable, argv: readonly string[]): string[] {
  const methodFlags = table.methodFlags ?? [];
  const split: string[] = [];
  for (const arg of argv) {
    const long = /^(--[\w-]+)=(.*)$/.exec(arg);
    if (long !== null) {
      split.push(long[1] as string, long[2] as string);
      continue;
    }
    const runOn = methodFlags.find(
      (flag) =>
        !flag.startsWith('--') && arg.startsWith(flag) && arg.length > flag.length,
    );
    if (runOn !== undefined) {
      split.push(runOn, arg.slice(runOn.length));
      continue;
    }
    split.push(arg);
  }
  for (let index = 0; index + 1 < split.length; index += 1) {
    if (methodFlags.includes(split[index] as string)) {
      split[index + 1] = (split[index + 1] as string).toUpperCase();
    }
  }
  return withoutLeadingGlobals(table, split);
}

function withoutLeadingGlobals(table: VerbTable, argv: readonly string[]): string[] {
  const valued = table.globalFlags ?? [];
  const switches = table.globalSwitches ?? [];
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index] as string;
    if (valued.some((flag) => flag.endsWith('=') && arg.startsWith(flag))) {
      index += 1;
      continue;
    }
    if (valued.includes(arg)) {
      index += 2;
      continue;
    }
    if (switches.includes(arg)) {
      index += 1;
      continue;
    }
    break;
  }
  return argv.slice(index);
}

/** Null when nothing in the table covers this command, which is `unknown`, not safe. */
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
  return table.verbs.filter((verb) => changesExternalState(verb.class));
}

export function destructiveVerbs(table: VerbTable): Verb[] {
  return table.verbs.filter((verb) => verb.class === TOOL_CLASS.DESTRUCTIVE);
}

/**
 * The single action name for a verb, shared by every screen and the interceptor, so a rule
 * written from one screen matches at every other.
 */
export function verbAction(cli: string, verb: Verb): string {
  if (verb.name !== undefined) return `${cli}.${verb.name}`;
  // Flags stay in the name, so a rule about force-pushing does not deny every push, and a
  // prefix keeps its stem, so `delete-**` and `describe-**` are two names rather than none.
  const words = verb.match
    .split(/\s+/)
    .map((word) => word.replace(/-?\*+$/, ''))
    .filter((word) => word !== '' && word !== '$')
    .map((word) => word.replace(/^-+/, '').toLowerCase());
  return words.length === 0 ? `${cli}.run` : `${cli}.${words.join('-')}`;
}

/**
 * The action a command line resolves to, whether or not a table covers it. A verb already
 * chosen, as a refined one is, names the action instead of matching again.
 */
export function actionForCommand(
  cli: string,
  table: VerbTable,
  argv: readonly string[],
  chosen?: Verb,
): string {
  const verb = chosen ?? matchVerb(table, argv)?.verb ?? UNKNOWN_VERB;
  return verb === UNKNOWN_VERB ? `${cli}.unknown` : verbAction(cli, verb);
}

const GRAPHQL_MUTATION = /^\s*mutation\b/;
const QUERY_FIELD = /^query=(.*)$/s;

/**
 * Where an argv pattern cannot see the difference, the argument can: a GraphQL call is
 * always a POST with a field, and only the query text says whether it reads or changes.
 */
export function refineVerb(cli: string, argv: readonly string[], verb: Verb): Verb {
  if (cli !== 'gh' || argv[0] !== 'api' || !argv.includes('graphql')) return verb;
  const query = argv
    .map((arg) => QUERY_FIELD.exec(arg)?.[1])
    .find((each) => each !== undefined);
  // A query from a file or stdin cannot be read here, so it keeps the write it matched.
  if (query === undefined || query.startsWith('@')) return verb;
  return GRAPHQL_BY_KIND[GRAPHQL_MUTATION.test(query) ? 'mutation' : 'query'];
}

const GRAPHQL_BY_KIND: Readonly<Record<'mutation' | 'query', Verb>> = {
  query: {
    match: 'api graphql **',
    class: TOOL_CLASS.READ,
    note: 'a GraphQL query reads',
  },
  mutation: {
    match: 'api graphql **',
    class: TOOL_CLASS.WRITE,
    note: 'a GraphQL mutation changes something',
  },
};

export function hasTag(verb: Verb, tag: VerbTag): boolean {
  return (verb.tags ?? []).includes(tag);
}

/**
 * The verb an action name came from, found by asking which verb produces that name rather
 * than splitting it back into argv, since `verbAction` drops the dashes.
 */
export function verbForAction(
  action: string,
  tableFor: (name: string) => VerbTable | null,
): Verb | null {
  const dot = action.indexOf('.');
  if (dot <= 0) return null;
  const cli = action.slice(0, dot);
  const table = tableFor(cli);
  if (table === null) return null;
  return table.verbs.find((each) => verbAction(cli, each) === action) ?? null;
}

/**
 * A command glob for one Memnox action, such as `git push --force*` for `git.push-force`,
 * derived from the table the evaluator reads so a compiled rule cannot drift.
 */
export function commandGlobFor(
  action: string,
  tableFor: (name: string) => VerbTable | null,
): string | null {
  const verb = verbForAction(action, tableFor);
  if (verb === null) return null;
  const cli = action.slice(0, action.indexOf('.'));
  // Nothing after is the command exactly, with no glob to widen it.
  if (/\s\$$/.test(verb.match))
    return `${cli} ${verb.match.replace(/\s*\$$/, '').trim()}`;
  // `**` means "and the rest", which is exactly what a trailing glob says.
  const pattern = verb.match.replace(/\s*\*\*\s*$/, '').trim();
  return pattern === '' ? `${cli}*` : `${cli} ${pattern}*`;
}
