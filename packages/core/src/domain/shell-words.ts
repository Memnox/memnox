/**
 * The words of one shell line as the shell will see them: where it splits, which words
 * were quoted, what a redirect writes and what a heredoc feeds in.
 */
import type { Redirects } from './shell-normalizer';

/**
 * Splits on `;`, `&&`, `||`, `|` and newlines that sit outside quotes, because a separator
 * inside `psql -c "SELECT 1; DROP TABLE t"` is part of the statement, not a second command.
 */
export function splitOutsideQuotes(input: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (const { index, width } of separatorsIn(input)) {
    parts.push(input.slice(start, index));
    start = index + width;
  }
  parts.push(input.slice(start));
  return parts;
}

function separatorsIn(input: string): { index: number; width: number }[] {
  const found: { index: number; width: number }[] = [];
  let quote: string | null = null;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] as string;
    // A backslash escapes the next character everywhere but inside single quotes.
    if (character === '\\' && quote !== "'") {
      index += 1;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    const width = separatorWidth(input, index);
    if (width === 0) continue;
    found.push({ index, width });
    index += width - 1;
  }
  return found;
}

function separatorWidth(input: string, index: number): number {
  const pair = input.slice(index, index + 2);
  if (pair === '&&' || pair === '||') return 2;
  const character = input[index];
  // `>|` is a redirect that clobbers, not a pipe.
  if (character === '|') return input[index - 1] === '>' ? 0 : 1;
  return character === ';' || character === '\n' ? 1 : 0;
}

const HEREDOC = /(^|[^<])<<(-?)[ \t]*(['"]?)([A-Za-z_][\w-]*)\3/g;
const HEREDOC_MARK = '\u0000heredoc';

/**
 * Takes each heredoc body out of the line and leaves a marker where it was opened, so the
 * body is read as the command's input rather than as commands of its own.
 */
export function liftHeredocs(raw: string): { text: string; bodies: string[] } {
  if (!raw.includes('<<')) return { text: raw, bodies: [] };
  const lines = raw.split('\n');
  const out: string[] = [];
  const bodies: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opened: { strip: boolean; delimiter: string }[] = [];
    out.push(
      (lines[index] as string).replace(
        HEREDOC,
        (_match, before: string, dash: string, _quote: string, delimiter: string) => {
          opened.push({ strip: dash === '-', delimiter });
          return `${before} ${HEREDOC_MARK}${bodies.length + opened.length - 1} `;
        },
      ),
    );
    for (const heredoc of opened) {
      const body = bodyFrom(lines, index + 1, heredoc);
      bodies.push(body.lines.join('\n'));
      index = body.end;
    }
  }
  return { text: out.join('\n'), bodies };
}

function bodyFrom(
  lines: readonly string[],
  from: number,
  { strip, delimiter }: { strip: boolean; delimiter: string },
): { lines: string[]; end: number } {
  const body: string[] = [];
  for (let index = from; index < lines.length; index += 1) {
    const line = lines[index] as string;
    // `<<-` lets the closing word be indented with tabs.
    if ((strip ? line.replace(/^\t+/, '') : line).trim() === delimiter) {
      return { lines: body, end: index };
    }
    body.push(line);
  }
  return { lines: body, end: lines.length - 1 };
}

export interface Token {
  text: string;
  quoted: boolean;
}

/** Splits on whitespace, honouring quotes, and says which words were quoted. */
export function tokenizeQuoted(input: string): Token[] {
  const tokens: Token[] = [];
  let current: Token | null = null;
  let quote: string | null = null;
  for (const character of input) {
    if (quote !== null) {
      if (character === quote) quote = null;
      else if (current !== null) current.text += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current ??= { text: '', quoted: false };
      current.quoted = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (current !== null) tokens.push(current);
      current = null;
      continue;
    }
    current ??= { text: '', quoted: false };
    current.text += character;
  }
  if (current !== null) tokens.push(current);
  return tokens;
}

const WRITE_REDIRECT = /^(?:\d*|&)(>>?|>\|)(.*)$/;
const READ_REDIRECT = /^\d*<(?![<&])(.*)$/;
const DEVICES = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;

interface Redirect {
  writes: boolean;
  target: string;
  /** Whether the target was the next word rather than joined to the operator. */
  usesNext: boolean;
}

function redirectOf(token: Token, next: Token | undefined): Redirect | null {
  if (token.quoted) return null;
  const write = WRITE_REDIRECT.exec(token.text);
  const read = write === null ? READ_REDIRECT.exec(token.text) : null;
  if (write === null && read === null) return null;
  const joined = write === null ? (read?.[1] as string) : (write[2] as string);
  if (joined !== '') return { writes: write !== null, target: joined, usesNext: false };
  return { writes: write !== null, target: next?.text ?? '', usesNext: true };
}

/**
 * Takes `> file`, `>> file`, `2> file`, `&> file` and `< file` out of argv and records the
 * files, because `echo x > ~/.bashrc` is a write that no argument of `echo` names.
 */
export function takeRedirects(
  tokens: readonly Token[],
  bodies: readonly string[],
  redirects: Redirects,
): { kept: Token[]; stdin?: string } {
  const kept: Token[] = [];
  let stdin: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as Token;
    if (!token.quoted && token.text.startsWith(HEREDOC_MARK)) {
      stdin = bodies[Number(token.text.slice(HEREDOC_MARK.length))] ?? '';
      continue;
    }
    // A here-string stays in argv, since `base64 -d <<< x` decodes the word itself.
    if (!token.quoted && token.text === '<<<') stdin = tokens[index + 1]?.text ?? stdin;
    const redirect = token.text === '<<<' ? null : redirectOf(token, tokens[index + 1]);
    if (redirect === null) {
      kept.push(token);
      continue;
    }
    if (redirect.usesNext) index += 1;
    // `2>&1` duplicates a descriptor, and a device is not a file anybody keeps.
    const { target } = redirect;
    if (target === '' || target.startsWith('&') || DEVICES.test(target)) continue;
    (redirect.writes ? redirects.writes : redirects.reads).push(target);
  }
  return { kept, ...(stdin === undefined ? {} : { stdin }) };
}
