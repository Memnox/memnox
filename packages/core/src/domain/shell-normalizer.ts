import {
  liftHeredocs,
  splitWithSeparators,
  takeRedirects,
  tokenizeQuoted,
  type Token,
} from './shell-words';
import {
  afterPrefix,
  basename,
  DOWNLOADERS,
  downloads,
  endsInInterpreter,
  INTERPRETERS,
  runsCode,
  stripEnvTokens,
} from './shell-runners';

/** Indirection the normalizer could not resolve. Never silently ignored. */
export const OPAQUE_REASON = {
  /** $VAR, `cmd`, or $(cmd), where the real command is not knowable here. */
  EXPANSION: 'shell-expansion',
  /** A decoder whose input is not a literal, so nothing can be decoded. */
  UNDECODABLE: 'undecodable-payload',
  /** A download run as code, piped or substituted in: the payload lives elsewhere. */
  REMOTE_SOURCE: 'remote-source',
  /** Wrapper nesting past the bound; deeper layers went uninspected. */
  TOO_DEEP: 'nesting-too-deep',
} as const;

export type OpaqueReason = (typeof OPAQUE_REASON)[keyof typeof OPAQUE_REASON];

export interface NormalizedCommand {
  /**
   * Every executable command found, unwrapped and decoded where possible, with flags
   * sorted ahead of operands so the same command always reads the same way.
   */
  segments: string[];
  /**
   * The same commands with argv in the order it was typed. A verb table matches argv
   * as written, and `vercel deploy --prod` canonicalized to `vercel --prod deploy`
   * resolves to the wrong verb, so resolution reads these and patterns read the above.
   */
  commands: string[];
  /** Sorted, deduplicated. Non-empty means something could not be resolved. */
  opaque: OpaqueReason[];
  /**
   * The same commands again, as argv with quoting kept and redirects taken out, so a
   * quoted `"SELECT 1; DROP TABLE t"` stays one argument rather than two commands.
   */
  parsed: ParsedCommand[];
  /** Files the line's redirects write and read, which no argv shows. */
  redirects: Redirects;
}

export interface ParsedCommand {
  argv: string[];
  /** A heredoc or here-string, which is where `psql <<EOF` keeps its statement. */
  stdin?: string;
  /** The files this command's own redirects write, so what it prints can be told apart. */
  writes?: string[];
}

export interface Redirects {
  writes: string[];
  reads: string[];
}

const MAX_DEPTH = 4;
const EXPANSION = /\$\{?[A-Za-z_(]|`/;
const CODE_FLAG_RUNNERS = new Map<string, string>([
  ['python', '-c'],
  ['python3', '-c'],
  ['perl', '-e'],
  ['ruby', '-e'],
  ['node', '-e'],
]);
const DECODERS = new Set(['base64', 'openssl']);

/** Flattens a command into what it will really run; offline, never executes anything. */
interface FoundCommand {
  canonical: string;
  literal: string;
  parsed: ParsedCommand;
}

interface Walk {
  found: FoundCommand[];
  opaque: Set<OpaqueReason>;
  redirects: Redirects;
}

export function normalizeShellCommand(raw: string): NormalizedCommand {
  const state: Walk = {
    found: [],
    opaque: new Set(),
    redirects: { writes: [], reads: [] },
  };
  walk(raw, 0, state);

  // Deduplicated on the canonical form, so every list names the same commands.
  const seen = new Set<string>();
  const segments: string[] = [];
  const commands: string[] = [];
  const parsed: ParsedCommand[] = [];
  for (const command of state.found) {
    const key = `${command.canonical}\u0000${command.parsed.stdin ?? ''}\u0000${(command.parsed.writes ?? []).join('\u0000')}`;
    if (command.canonical.length === 0 || seen.has(key)) continue;
    seen.add(key);
    segments.push(command.canonical);
    commands.push(command.literal);
    parsed.push(command.parsed);
  }
  return {
    segments,
    commands,
    opaque: [...state.opaque].sort(),
    parsed,
    redirects: {
      writes: [...new Set(state.redirects.writes)],
      reads: [...new Set(state.redirects.reads)],
    },
  };
}

function walk(raw: string, depth: number, state: Walk): void {
  if (depth > MAX_DEPTH) {
    state.opaque.add(OPAQUE_REASON.TOO_DEEP);
    return;
  }
  const { text, bodies } = liftHeredocs(raw);
  const split = splitWithSeparators(text);
  const pipeline = split.map((part) => part.text.trim());
  const line: Line = {
    bodies,
    depth,
    pipesIntoInterpreter: pipeline.length > 1 && endsInInterpreter(pipeline),
  };
  const bindable = bindableNames(text, pipeline);
  const known = new Map<string, string>();

  for (const [index, written] of pipeline.entries()) {
    if (written.length === 0) continue;
    const part = substituteKnown(written, known);
    const assigned = tokenizeQuoted(part);
    const tokens = stripEnvTokens(assigned);
    if (tokens.length === 0)
      remember(assigned, split[index]?.then ?? '', bindable, known);
    else walkCommand(part, tokens, line, state);
  }
}

/** What every command of one line shares while it is walked. */
interface Line {
  bodies: string[];
  depth: number;
  pipesIntoInterpreter: boolean;
}

function walkCommand(part: string, tokens: Token[], line: Line, state: Walk): void {
  const { found, opaque } = state;
  const own: Redirects = { writes: [], reads: [] };
  const { kept, stdin } = takeRedirects(tokens, line.bodies, own);
  state.redirects.writes.push(...own.writes);
  state.redirects.reads.push(...own.reads);
  const words = kept.map((token) => token.text);
  if (words.length === 0) return;

  if (EXPANSION.test(outsideSingleQuotes(part))) opaque.add(OPAQUE_REASON.EXPANSION);
  // What a substitution runs is a command like any other, so `echo $(rm -rf ~)` is an rm.
  for (const body of substitutionsIn(part)) walk(body, line.depth + 1, state);

  const binary = basename(words[0] ?? '');
  if (line.pipesIntoInterpreter && DOWNLOADERS.has(binary)) {
    opaque.add(OPAQUE_REASON.REMOTE_SOURCE);
  }
  if (runsCode(binary) && substitutionsIn(part).some(downloads)) {
    opaque.add(OPAQUE_REASON.REMOTE_SOURCE);
  }

  const inner = unwrap(binary, words, opaque);
  if (inner !== null) {
    walk(inner, line.depth + 1, state);
    return;
  }
  found.push({
    canonical: canonicalize(words),
    literal: words.join(' '),
    parsed: {
      argv: words,
      ...(stdin === undefined ? {} : { stdin }),
      ...(own.writes.length === 0 ? {} : { writes: own.writes }),
    },
  });
}

/** A value that says what it is: a path or a word, nothing the shell would split or expand. */
const LITERAL_BINDING = /^([A-Za-z_][A-Za-z0-9_]*)=([\w@%+=:,./~-]*)$/;

/** Separators after which the next command runs in the same shell, with the variable set. */
const CARRIES = new Set([';', '\n', '&&']);

/** Commands that can set a variable nothing in the line spells out. */
const HIDDEN_ASSIGNERS = new Set(['eval', 'source', '.']);

/**
 * Names whose one assignment is the only place they are written bare, so `$S` can only
 * be that value; `for S in`, `read S` or a second `S=` anywhere leaves `$S` unknown.
 */
function bindableNames(text: string, pipeline: readonly string[]): Set<string> {
  const names = new Set<string>();
  const runsHidden = pipeline.some((part) =>
    HIDDEN_ASSIGNERS.has(stripEnvTokens(tokenizeQuoted(part))[0]?.text ?? ''),
  );
  if (runsHidden) return names;
  for (const part of pipeline) {
    for (const token of tokenizeQuoted(part)) {
      const name = LITERAL_BINDING.exec(token.text)?.[1];
      if (name === undefined) continue;
      const bare = text.match(new RegExp(`(?<![$\\w{])${name}(?!\\w)`, 'g')) ?? [];
      if (bare.length === 1) names.add(name);
    }
  }
  return names;
}

/** A part that only assigns, remembered where the next command inherits what it set. */
function remember(
  assigned: readonly Token[],
  then: string,
  bindable: ReadonlySet<string>,
  known: Map<string, string>,
): void {
  if (!CARRIES.has(then)) return;
  for (const token of assigned) {
    const bound = LITERAL_BINDING.exec(token.text);
    if (bound === null || token.quoted) continue;
    const [, name, value] = bound;
    if (name !== undefined && value !== undefined && bindable.has(name))
      known.set(name, value);
  }
}

/** `$NAME` and `${NAME}` replaced where the line itself set them, and nowhere inside single quotes. */
function substituteKnown(part: string, known: ReadonlyMap<string, string>): string {
  if (known.size === 0) return part;
  let out = '';
  let quote: string | null = null;
  for (let at = 0; at < part.length; at += 1) {
    const character = part[at] as string;
    if (character === '\\' && quote !== "'") {
      out += part.slice(at, at + 2);
      at += 1;
      continue;
    }
    if (quote !== null && character === quote) quote = null;
    else if (quote === null && (character === "'" || character === '"'))
      quote = character;
    const reference =
      character === '$' && quote !== "'"
        ? /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/.exec(part.slice(at))
        : null;
    const name = reference?.[1] ?? reference?.[2];
    const value = name === undefined ? undefined : known.get(name);
    if (reference !== null && value !== undefined) {
      out += value;
      at += reference[0].length - 1;
      continue;
    }
    out += character;
  }
  return out;
}

/** The part without its single-quoted text, since the shell expands nothing inside it. */
function outsideSingleQuotes(part: string): string {
  let out = '';
  let quote: string | null = null;
  for (let at = 0; at < part.length; at += 1) {
    const character = part[at] as string;
    if (character === '\\' && quote !== "'") {
      out += part.slice(at, at + 2);
      at += 1;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === null && character === "'") {
      quote = character;
      continue;
    }
    if (character === '"') quote = quote === '"' ? null : '"';
    out += character;
  }
  return out;
}

/**
 * The bodies of `$(...)`, `<(...)`, `>(...)` and backticks in a command, outermost first, so
 * what they run is ruled on rather than only noted as something the line could not see through.
 */
function substitutionsIn(part: string): string[] {
  const bodies: string[] = [];
  for (let at = 0; at < part.length; at += 1) {
    if (part[at] === '`') {
      const end = part.indexOf('`', at + 1);
      if (end === -1) break;
      bodies.push(part.slice(at + 1, end));
      at = end;
    } else if (
      (part[at] === '$' || part[at] === '<' || part[at] === '>') &&
      part[at + 1] === '(' &&
      part[at + 2] !== '('
    ) {
      let depth = 0;
      for (let end = at + 1; end < part.length; end += 1) {
        if (part[end] === '(') depth += 1;
        if (part[end] === ')') depth -= 1;
        if (depth === 0) {
          bodies.push(part.slice(at + 2, end));
          at = end;
          break;
        }
      }
    }
  }
  return bodies;
}

/** `timeout 5 rm x`: the duration is the first word, then the command. */
function afterTimeout(words: readonly string[]): string | null {
  let at = 1;
  while (at < words.length && (words[at] ?? '').startsWith('-')) at += 1;
  const rest = words.slice(at + 1);
  return rest.length === 0 ? null : rest.join(' ');
}

/** `find . -delete` removes what it finds, and `-exec rm {} ;` runs rm on each. */
function findRuns(words: readonly string[]): string | null {
  const exec = words.findIndex(
    (word) => word === '-exec' || word === '-execdir' || word === '-ok',
  );
  if (exec !== -1) {
    const end = words.findIndex(
      (word, at) => at > exec && (word === ';' || word === '\\;' || word === '+'),
    );
    return words.slice(exec + 1, end === -1 ? undefined : end).join(' ') || null;
  }
  if (words.includes('-delete')) {
    const start = words[1] !== undefined && !words[1].startsWith('-') ? words[1] : '.';
    return `rm -rf ${start}`;
  }
  return null;
}

/** `git -c alias.x='!rm -rf ~' x` runs the alias body as shell, whatever the verb says. */
function gitAliasRuns(words: readonly string[]): string | null {
  for (let at = 1; at < words.length - 1; at += 1) {
    if (words[at] !== '-c') continue;
    const shell = /^alias\.[^=]+=!(.+)$/.exec(words[at + 1] ?? '');
    if (shell !== null) return shell[1] ?? null;
  }
  return null;
}

/** `-c`, and the same flag run together with others: `bash -lc`, `sh -ec`. */
function codeFlagAt(words: readonly string[]): number {
  return words.findIndex((word, at) => at > 0 && /^-[a-z]*c[a-z]*$/.test(word));
}

/** Returns the wrapped command when this word list is a wrapper, else null. */
function unwrap(
  binary: string,
  words: readonly string[],
  opaque: Set<OpaqueReason>,
): string | null {
  if (binary === 'eval' || binary === 'exec') {
    return words.slice(1).join(' ');
  }
  if (binary === 'timeout') return afterTimeout(words);
  if (binary === 'find') return findRuns(words);
  if (binary === 'git') return gitAliasRuns(words);
  const prefixed = afterPrefix(binary, words);
  if (prefixed !== null) return prefixed;
  if (INTERPRETERS.has(binary)) {
    const index = codeFlagAt(words);
    if (index !== -1 && index + 1 < words.length) return words[index + 1] ?? null;
    return null;
  }
  const codeFlag = CODE_FLAG_RUNNERS.get(binary);
  if (codeFlag !== undefined) {
    const index = words.indexOf(codeFlag);
    if (index !== -1 && index + 1 < words.length) return words[index + 1] ?? null;
    return null;
  }
  if (DECODERS.has(binary) && isDecoding(words)) {
    const literal = words[words.length - 1];
    // A decoder reading a pipe or a file has no literal to decode here.
    if (literal === undefined || literal === '-' || looksLikeFlag(literal)) {
      opaque.add(OPAQUE_REASON.UNDECODABLE);
      return null;
    }
    const decoded = decodeBase64(literal);
    if (decoded === null) {
      opaque.add(OPAQUE_REASON.UNDECODABLE);
      return null;
    }
    return decoded;
  }
  return null;
}

function isDecoding(words: readonly string[]): boolean {
  return words.some((word) => word === '-d' || word === '--decode' || word === '-D');
}

function decodeBase64(value: string): string | null {
  if (!/^[A-Za-z0-9+/=\s]+$/.test(value) || value.length < 4) return null;
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    // Reject binary noise: only a text command is worth re-inspecting.
    return /^[\x20-\x7e\s]+$/.test(decoded) && decoded.trim().length > 0 ? decoded : null;
  } catch {
    return null; // Not valid base64, so treat it as an ordinary argument.
  }
}

function looksLikeFlag(word: string): boolean {
  return word.startsWith('-');
}

/** One spelling per command, so `rm -r -f /x` and `/bin/rm -fr /x` match one pattern. */
function canonicalize(words: readonly string[]): string {
  const binary = basename(words[0] ?? '');
  const flags: string[] = [];
  const operands: string[] = [];

  for (const word of words.slice(1)) {
    if (word.startsWith('--')) {
      flags.push(word);
      continue;
    }
    if (word.startsWith('-') && word.length > 1) {
      for (const letter of word.slice(1)) flags.push(`-${letter}`);
      continue;
    }
    operands.push(word);
  }
  const unique = [...new Set(flags)].sort();
  return [binary, ...unique, ...operands].join(' ');
}
