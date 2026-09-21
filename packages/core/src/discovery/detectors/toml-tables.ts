import { findOutsideQuotes, openBrackets, unquote } from '../scalar-text';

/**
 * Enough TOML to read a config's server tables, because a full parser is a dependency
 * and an attack surface for four keys. An unrecognised shape comes back absent.
 */
export interface TomlTables {
  /** Dotted table path, so `[mcp_servers.github.env]` is `mcp_servers.github.env`. */
  tables: Map<string, Map<string, TomlValue>>;
}

export type TomlValue = { text: string } | { list: string[] } | { keys: string[] };

const ROOT = '';

export function parseTomlTables(raw: string | null): TomlTables {
  const tables = new Map<string, Map<string, TomlValue>>();
  if (raw === null) return { tables };

  let current = new Map<string, TomlValue>();
  tables.set(ROOT, current);

  for (const line of joinArrays(raw)) {
    const text = stripComment(line).trim();
    if (text === '') continue;

    if (text.startsWith('[')) {
      // `[[x]]` is an array of tables; it names one and we only ever read the last.
      const header = text.replace(/^\[+/, '').replace(/\]+$/, '').trim();
      current = tables.get(header) ?? new Map<string, TomlValue>();
      tables.set(header, current);
      continue;
    }

    const split = text.indexOf('=');
    if (split <= 0) continue;
    const key = unquote(text.slice(0, split).trim());
    if (key === '') continue;
    const value = valueOf(text.slice(split + 1).trim());
    if (value === null) continue;
    current.set(key, value);
  }
  return { tables };
}

/** An array written across several lines is folded into one, so the reader stays a line at a time. */
function joinArrays(raw: string): string[] {
  const lines: string[] = [];
  let pending: string | null = null;
  for (const line of raw.split('\n')) {
    const text: string = pending === null ? line : `${pending} ${line.trim()}`;
    // A table header opens and closes on its own line, so this only holds for arrays.
    if (openBrackets(text) > 0 && !text.trim().startsWith('[')) {
      pending = text;
      continue;
    }
    pending = null;
    lines.push(text);
  }
  if (pending !== null) lines.push(pending);
  return lines;
}

/** A `#` inside quotes is data. Anywhere else on the line it starts a comment. */
function stripComment(line: string): string {
  const at = findOutsideQuotes(line, (char) => char === '#');
  return at === -1 ? line : line.slice(0, at);
}

function valueOf(raw: string): TomlValue | null {
  if (raw === '') return null;
  if (raw.startsWith('[')) return { list: itemsIn(raw) };
  // An inline table is read for its key names only: a value here would be a value kept.
  if (raw.startsWith('{')) return { keys: inlineKeys(raw) };
  return { text: unquote(raw) };
}

function itemsIn(raw: string): string[] {
  const close = raw.lastIndexOf(']');
  return splitTop(raw.slice(1, close === -1 ? undefined : close))
    .map(unquote)
    .filter((each) => each !== '');
}

function inlineKeys(raw: string): string[] {
  const close = raw.lastIndexOf('}');
  return splitTop(raw.slice(1, close === -1 ? undefined : close))
    .map((pair) => unquote(pair.slice(0, pair.indexOf('=')).trim()))
    .filter((each) => each !== '')
    .sort();
}

/** Splits on commas that are not inside a string, a nested array or an inline table. */
function splitTop(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  findOutsideQuotes(inner, (char, at) => {
    if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(inner.slice(start, at).trim());
      start = at + 1;
    }
    return false;
  });
  parts.push(inner.slice(start).trim());
  return parts.filter((each) => each !== '');
}

/** The immediate children of a table path, e.g. every server under `mcp_servers`. */
export function childTablesOf(parsed: TomlTables, path: string): string[] {
  const prefix = `${path}.`;
  const names = new Set<string>();
  for (const key of parsed.tables.keys()) {
    if (!key.startsWith(prefix)) continue;
    const name = key.slice(prefix.length).split('.')[0];
    if (name !== undefined && name !== '') names.add(name);
  }
  return [...names];
}

export function stringAt(parsed: TomlTables, path: string, key: string): string | null {
  const value = parsed.tables.get(path)?.get(key);
  return value !== undefined && 'text' in value ? value.text : null;
}

export function listAt(parsed: TomlTables, path: string, key: string): string[] {
  const value = parsed.tables.get(path)?.get(key);
  if (value === undefined) return [];
  if ('list' in value) return [...value.list];
  return 'text' in value ? [value.text] : [];
}

/** The names a table hands over, as its own `[x.env]` or inline `env = { A = "..." }`. Never a value. */
export function keyNamesAt(parsed: TomlTables, path: string, key: string): string[] {
  const own = parsed.tables.get(`${path}.${key}`);
  if (own !== undefined) return [...own.keys()].sort();
  const inline = parsed.tables.get(path)?.get(key);
  return inline !== undefined && 'keys' in inline ? [...inline.keys] : [];
}
