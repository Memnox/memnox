/**
 * The scalar and quote rules every small config reader here shares: YAML, TOML and JSON
 * with comments. None of them is a full parser, and none keeps its own copy of these.
 */

/** Which characters open a string, and whether a backslash escapes inside one. */
interface Quoting {
  quotes: string;
  escapes: boolean;
}

/** YAML and TOML as these readers treat them: either quote, no escapes. */
const CONFIG_QUOTING: Quoting = { quotes: `"'`, escapes: false };

/** JSON strings: double quotes only, and `\"` does not close one. */
export const JSON_QUOTING: Quoting = { quotes: '"', escapes: true };

/**
 * The index of the first character outside a quoted string that `matches` accepts, or
 * -1. Quote characters themselves are never offered, because they are syntax.
 */
export function findOutsideQuotes(
  text: string,
  matches: (char: string, at: number) => boolean,
  quoting: Quoting = CONFIG_QUOTING,
): number {
  let quote: string | null = null;
  let escaped = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] as string;
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (quoting.escapes && char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (quoting.quotes.includes(char)) quote = char;
    else if (matches(char, at)) return at;
  }
  return -1;
}

/** How many times `char` appears outside a quoted string. */
function countOutsideQuotes(text: string, char: string): number {
  let total = 0;
  findOutsideQuotes(text, (each) => {
    if (each === char) total += 1;
    return false;
  });
  return total;
}

/** `[` opened minus `]` closed, so a positive number is an array still open. */
export function openBrackets(text: string): number {
  return countOutsideQuotes(text, '[') - countOutsideQuotes(text, ']');
}

/** `key: rest`, where an empty key or a leading colon is not a key at all. */
export function splitKey(text: string): [string, string] | null {
  const at = text.indexOf(':');
  if (at <= 0) return null;
  const key = text.slice(0, at).trim();
  if (key === '') return null;
  return [unquote(key), text.slice(at + 1).trim()];
}

/** A matching pair of quotes taken off, and anything else left exactly as written. */
export function unquote(text: string): string {
  const first = text[0];
  if ((first === '"' || first === "'") && text.endsWith(first) && text.length > 1) {
    return text.slice(1, -1);
  }
  return text;
}

/** `[a, "b", c]` on one line, which is how a tool filter is usually written. */
export function flowItems(text: string): string[] {
  const close = text.lastIndexOf(']');
  return text
    .slice(1, close === -1 ? undefined : close)
    .split(',')
    .map((each) => unquote(each.trim()))
    .filter((each) => each !== '');
}
