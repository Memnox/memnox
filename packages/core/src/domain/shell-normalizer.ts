/** Indirection the normalizer could not resolve. Never silently ignored. */
export const OPAQUE_REASON = {
  /** $VAR, `cmd`, or $(cmd) — the real command is not knowable here. */
  EXPANSION: 'shell-expansion',
  /** A decoder whose input is not a literal, so nothing can be decoded. */
  UNDECODABLE: 'undecodable-payload',
  /** Piping a download into an interpreter: the payload lives elsewhere. */
  REMOTE_SOURCE: 'remote-source',
  /** Wrapper nesting past the bound; deeper layers went uninspected. */
  TOO_DEEP: 'nesting-too-deep',
} as const;

export type OpaqueReason = (typeof OPAQUE_REASON)[keyof typeof OPAQUE_REASON];

export interface NormalizedCommand {
  /** Every executable command found, unwrapped and decoded where possible. */
  segments: string[];
  /** Sorted, deduplicated. Non-empty means something could not be resolved. */
  opaque: OpaqueReason[];
}

const MAX_DEPTH = 4;
const SEPARATORS = /\|\||&&|[|;\n]/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/;
const EXPANSION = /\$\{?[A-Za-z_(]|`/;
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash']);
const CODE_FLAG_RUNNERS = new Map<string, string>([
  ['python', '-c'],
  ['python3', '-c'],
  ['perl', '-e'],
  ['ruby', '-e'],
  ['node', '-e'],
]);
const DECODERS = new Set(['base64', 'openssl']);
const DOWNLOADERS = new Set(['curl', 'wget', 'fetch']);

/** Flattens a command into what it will really run; offline, never executes anything. */
export function normalizeShellCommand(raw: string): NormalizedCommand {
  const segments: string[] = [];
  const opaque = new Set<OpaqueReason>();
  walk(raw, 0, segments, opaque);
  return {
    segments: [...new Set(segments.filter((segment) => segment.length > 0))],
    opaque: [...opaque].sort(),
  };
}

function walk(
  raw: string,
  depth: number,
  segments: string[],
  opaque: Set<OpaqueReason>,
): void {
  if (depth > MAX_DEPTH) {
    opaque.add(OPAQUE_REASON.TOO_DEEP);
    return;
  }
  const pipeline = raw.split(SEPARATORS).map((part) => part.trim());
  const pipesIntoInterpreter = pipeline.length > 1 && endsInInterpreter(pipeline);

  for (const part of pipeline) {
    if (part.length === 0) continue;
    const words = stripEnvAssignments(tokenize(part));
    if (words.length === 0) continue;

    if (EXPANSION.test(part)) opaque.add(OPAQUE_REASON.EXPANSION);

    const binary = basename(words[0] ?? '');
    if (pipesIntoInterpreter && DOWNLOADERS.has(binary)) {
      opaque.add(OPAQUE_REASON.REMOTE_SOURCE);
    }

    const inner = unwrap(binary, words, opaque);
    if (inner !== null) {
      walk(inner, depth + 1, segments, opaque);
      continue;
    }
    segments.push(canonicalize(words));
  }
}

/** `curl x | sh` — the last stage decides whether the pipeline executes. */
function endsInInterpreter(pipeline: string[]): boolean {
  const last = pipeline[pipeline.length - 1];
  if (last === undefined) return false;
  const words = stripEnvAssignments(tokenize(last));
  return INTERPRETERS.has(basename(words[0] ?? ''));
}

/** Returns the wrapped command when this word list is a wrapper, else null. */
function unwrap(
  binary: string,
  words: string[],
  opaque: Set<OpaqueReason>,
): string | null {
  if (binary === 'eval' || binary === 'exec') {
    return words.slice(1).join(' ');
  }
  if (INTERPRETERS.has(binary)) {
    const index = words.indexOf('-c');
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

function isDecoding(words: string[]): boolean {
  return words.some((word) => word === '-d' || word === '--decode' || word === '-D');
}

function decodeBase64(value: string): string | null {
  if (!/^[A-Za-z0-9+/=\s]+$/.test(value) || value.length < 4) return null;
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    // Reject binary noise: only a text command is worth re-inspecting.
    return /^[\x20-\x7e\s]+$/.test(decoded) && decoded.trim().length > 0 ? decoded : null;
  } catch {
    return null; // Not valid base64 — treat it as an ordinary argument.
  }
}

/** Splits on whitespace, honouring quotes and keeping quoted content intact. */
function tokenize(input: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: string | null = null;

  for (const character of input) {
    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current.length > 0) words.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current.length > 0) words.push(current);
  return words;
}

/** `FOO=bar rm -rf /` runs rm, not FOO. */
function stripEnvAssignments(words: string[]): string[] {
  let index = 0;
  while (index < words.length && ENV_ASSIGNMENT.test(words[index] ?? '')) index += 1;
  return words.slice(index);
}

function basename(word: string): string {
  const parts = word.split('/');
  return parts[parts.length - 1] ?? word;
}

function looksLikeFlag(word: string): boolean {
  return word.startsWith('-');
}

/** One spelling per command, so `rm -r -f /x` and `/bin/rm -fr /x` match one pattern. */
function canonicalize(words: string[]): string {
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
