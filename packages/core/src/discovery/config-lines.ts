/**
 * Line-level helpers for editing a TOML or YAML config in place, shared by the server
 * rewrite and the YAML list edit so both read a key and write a value the same way.
 */

/** How a file already quotes a value, so a replacement is written the same way. */
export type QuoteStyle = '"' | "'" | 'bare';

/**
 * Words a YAML parser turns into something that is not a string. Hermes reads with a real
 * parser, so a bare `- yes` would start the server with the boolean true.
 */
const YAML_KEYWORDS = /^(?:y|n|yes|no|true|false|on|off|null|~)$/i;

export function indentOf(line: string): string {
  return line.slice(0, line.length - line.trimStart().length);
}

/** A key with any surrounding quote taken off, the way a header or mapping key is compared. */
export function keyNameOf(text: string): string {
  return text.trim().replace(/^["']|["']$/g, '');
}

/** Whether a trimmed line declares `key` as a mapping key, quoted or bare. */
export function matchesKey(text: string, key: string): boolean {
  const colon = text.indexOf(':');
  return colon > 0 && keyNameOf(text.slice(0, colon)) === key;
}

/** The line declaring a mapping key, from `from` onward. Quoted or bare. */
export function keyLine(lines: readonly string[], key: string, from: number): number {
  for (let at = from; at < lines.length; at += 1) {
    const text = (lines[at] as string).trim();
    if (text.startsWith('#') || text.startsWith('-')) continue;
    if (matchesKey(text, key)) return at;
  }
  return -1;
}

/** Written the way the file already writes them, and quoted anyway when it must be. */
export function scalarText(value: string, style: QuoteStyle): string {
  if (style === 'bare' && canBeBare(value)) return value;
  if (style === "'" && !value.includes("'")) return `'${value}'`;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** A YAML scalar needs quoting the moment it could be read as anything else. */
function canBeBare(value: string): boolean {
  if (value === '' || /[\s:#,[\]{}'"&*!|>%@`]/.test(value)) return false;
  if (YAML_KEYWORDS.test(value)) return false;
  // A number left bare comes back as a number, which is a different argument.
  return Number.isNaN(Number(value));
}
