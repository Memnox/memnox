/**
 * What runs what on a shell line: the prefixes that only run the next word, the interpreters
 * that run code, and the downloaders whose output must never be taken as that code.
 */
import { tokenizeQuoted, type Token } from './shell-words';

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/;
/** Shells, whose `-c` argument is shell code and is walked as one more line. */
export const SHELLS = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash']);
/**
 * Everything that runs code it is handed, shells among them. Its code cannot be read from
 * here, so any path on the line could be one it writes.
 */
export const CODE_RUNNERS = new Set([
  ...SHELLS,
  'fish',
  'python',
  'python3',
  'node',
  'deno',
  'bun',
  'ruby',
  'perl',
  'php',
  'pwsh',
  'osascript',
  'lua',
  'tclsh',
]);
export const DOWNLOADERS = new Set(['curl', 'wget', 'fetch']);
/** How many prefixes deep a piped interpreter is looked for: `sudo env bash` is two. */
const PREFIX_LAYERS = 4;
/** Languages that run what they read on stdin when given no code and no script. */
const LANGUAGE_INTERPRETER =
  /^(?:python[23]?|node|ruby|perl|fish|pwsh)(?:\d+(?:\.\d+)*)?$/;
/** The words that hand a language its code or a script, so stdin is only its data. */
const LANGUAGE_CODE_FLAGS = new Set(['-c', '-m', '-e', '-E', '-p', '--eval', '--print']);
/** Prefixes a piped interpreter hides behind: `curl x | sudo bash`. */
const PIPE_PREFIXES = new Set(['sudo', 'env', 'doas', 'command']);
/** Words that run their argument as code, so a download substituted into one runs too. */
const RUNS_ARGUMENT = new Set(['eval', 'source', '.']);

/** Words that only run the next one, and how many values each of their options takes. */
const PREFIXES = new Map<string, ReadonlySet<string>>([
  ['env', new Set(['-u', '--unset', '-C', '--chdir', '-S'])],
  ['sudo', new Set(['-u', '-g', '-C', '-h', '-p', '-U', '-r', '-t', '-D'])],
  ['doas', new Set(['-u', '-C'])],
  ['command', new Set()],
  ['nohup', new Set()],
  ['time', new Set()],
  ['nice', new Set(['-n'])],
  ['ionice', new Set(['-c', '-n', '-p'])],
  ['stdbuf', new Set(['-i', '-o', '-e'])],
  ['xargs', new Set(['-n', '-I', '-L', '-P', '-s', '-d', '-E', '-a'])],
  ['timeout', new Set(['-s', '--signal', '-k', '--kill-after'])],
  ['exec', new Set(['-a'])],
]);

/** Prefixes whose first word past their options is how long to run, not what runs. */
const TAKES_DURATION = new Set(['timeout']);

/** The words a prefix runs, past its own options, its `NAME=value` words and its duration. */
function prefixRest(binary: string, words: readonly string[]): readonly string[] | null {
  const valued = PREFIXES.get(binary);
  if (valued === undefined) return null;
  let at = 1;
  while (at < words.length) {
    const word = words[at] ?? '';
    if (valued.has(word)) at += 2;
    else if (word.startsWith('-') || ENV_ASSIGNMENT.test(word)) at += 1;
    else break;
  }
  if (TAKES_DURATION.has(binary)) at += 1;
  const rest = words.slice(at);
  return rest.length === 0 ? null : rest;
}

/** The command a prefix runs, as one line. */
export function afterPrefix(binary: string, words: readonly string[]): string | null {
  return prefixRest(binary, words)?.join(' ') ?? null;
}

/**
 * The command under every prefix and leading `NAME=value`: `sudo -u root env X=1 python3`
 * down to `python3`. One walk shared by the normalizer and the resolver, which each kept a
 * list of their own and so disagreed about `doas`, `stdbuf`, `timeout` and an option value.
 */
export function underPrefixes(words: readonly string[]): readonly string[] {
  let current = words;
  for (let layer = 0; layer < PREFIX_LAYERS; layer += 1) {
    let start = 0;
    while (ENV_ASSIGNMENT.test(current[start] ?? '')) start += 1;
    current = current.slice(start);
    const rest = prefixRest(basename(current[0] ?? ''), current);
    if (rest === null) break;
    current = rest;
  }
  return current;
}

export function basename(word: string): string {
  const parts = word.split('/');
  return parts[parts.length - 1] ?? word;
}

export function stripEnvTokens(tokens: readonly Token[]): Token[] {
  let index = 0;
  while (index < tokens.length && ENV_ASSIGNMENT.test(tokens[index]?.text ?? ''))
    index += 1;
  return tokens.slice(index);
}

/** `curl x | sh`, where the last stage decides whether the pipeline executes. */
export function endsInInterpreter(pipeline: readonly string[]): boolean {
  const last = pipeline[pipeline.length - 1];
  if (last === undefined) return false;
  let words = stripEnvTokens(tokenizeQuoted(last)).map((token) => token.text);
  for (let layer = 0; layer < PREFIX_LAYERS; layer += 1) {
    const binary = basename(words[0] ?? '');
    if (!PIPE_PREFIXES.has(binary)) break;
    const rest = afterPrefix(binary, words);
    if (rest === null) return false;
    words = tokenizeQuoted(rest).map((token) => token.text);
  }
  const binary = basename(words[0] ?? '');
  if (SHELLS.has(binary)) return true;
  // `curl api | python3 -m json.tool` reads the download as data, so only a bare language counts.
  return LANGUAGE_INTERPRETER.test(binary) && readsProgramFromStdin(words);
}

function readsProgramFromStdin(words: readonly string[]): boolean {
  for (const word of words.slice(1)) {
    if (word === '-') return true;
    if (LANGUAGE_CODE_FLAGS.has(word) || /^-command$|^-file$/i.test(word)) return false;
    if (!word.startsWith('-')) return false;
  }
  return true;
}

/** A shell, a language or `eval`, any of which runs a substituted download as its code. */
export function runsCode(binary: string): boolean {
  return (
    SHELLS.has(binary) || LANGUAGE_INTERPRETER.test(binary) || RUNS_ARGUMENT.has(binary)
  );
}

/** A substitution body whose command, past any env words, is a downloader. */
export function downloads(body: string): boolean {
  const words = stripEnvTokens(tokenizeQuoted(body.trim()));
  return DOWNLOADERS.has(basename(words[0]?.text ?? ''));
}
