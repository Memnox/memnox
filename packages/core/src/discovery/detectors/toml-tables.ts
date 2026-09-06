/**
 * Enough TOML to read a config's server tables, and deliberately no more. Same trade
 * as the YAML reader beside it: a full parser is a dependency and an attack surface
 * for a file we take four keys out of, and a shape this does not understand comes
 * back absent rather than guessed at.
 *
 * Tables are flattened to their dotted path, so `[mcp_servers.github.env]` is the key
 * `mcp_servers.github.env`. A caller asks for a path and gets that table's own pairs.
 */
export interface TomlTables {
  /** Dotted table path to the key/value pairs declared directly under it. */
  tables: Map<string, Map<string, TomlValue>>;
}

export type TomlValue = { text: string } | { list: string[] } | { keys: string[] };

const ROOT = '';

export function parseTomlTables(raw: string | null): TomlTables {
  const tables = new Map<string, Map<string, TomlValue>>();
  if (raw === null) return { tables };

  let current = ROOT;
  tables.set(ROOT, new Map());

  for (const line of joinArrays(raw)) {
    const text = stripComment(line).trim();
    if (text === '') continue;

    if (text.startsWith('[')) {
      // `[[x]]` is an array of tables; it names one and we only ever read the last.
      const header = text.replace(/^\[+/, '').replace(/\]+$/, '').trim();
      current = header;
      if (!tables.has(current)) tables.set(current, new Map());
      continue;
    }

    const split = text.indexOf('=');
    if (split <= 0) continue;
    const key = unquote(text.slice(0, split).trim());
    if (key === '') continue;
    const value = valueOf(text.slice(split + 1).trim());
    if (value === null) continue;
    (tables.get(current) as Map<string, TomlValue>).set(key, value);
  }
  return { tables };
}

/**
 * An array may be written across several lines. Folding them into one before parsing
 * keeps the reader a line at a time, which is the only reason it stays this small.
 */
function joinArrays(raw: string): string[] {
  const lines: string[] = [];
  let pending: string | null = null;
  for (const line of raw.split('\n')) {
    const text: string = pending === null ? line : `${pending} ${line.trim()}`;
    const opens = countOutsideQuotes(text, '[');
    const closes = countOutsideQuotes(text, ']');
    // A table header opens and closes on its own line, so this only holds for arrays.
    if (opens > closes && !text.trim().startsWith('[')) {
      pending = text;
      continue;
    }
    pending = null;
    lines.push(text);
  }
  if (pending !== null) lines.push(pending);
  return lines;
}

function countOutsideQuotes(text: string, char: string): number {
  let quote: string | null = null;
  let total = 0;
  for (let at = 0; at < text.length; at += 1) {
    const c = text[at] as string;
    if (quote !== null) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === char) total += 1;
  }
  return total;
}

/** A `#` inside quotes is data. Anywhere else on the line it starts a comment. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let at = 0; at < line.length; at += 1) {
    const c = line[at] as string;
    if (quote !== null) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '#') return line.slice(0, at);
  }
  return line;
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
  let quote: string | null = null;
  let start = 0;
  for (let at = 0; at < inner.length; at += 1) {
    const c = inner[at] as string;
    if (quote !== null) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth += 1;
    else if (c === ']' || c === '}') depth -= 1;
    else if (c === ',' && depth === 0) {
      parts.push(inner.slice(start, at).trim());
      start = at + 1;
    }
  }
  parts.push(inner.slice(start).trim());
  return parts.filter((each) => each !== '');
}

function unquote(text: string): string {
  const first = text[0];
  if ((first === '"' || first === "'") && text.endsWith(first) && text.length > 1) {
    return text.slice(1, -1);
  }
  return text;
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

/**
 * The names a table hands over, whether it was written as its own `[x.env]` table or
 * inline as `env = { A = "..." }`. Names only: a value read here would be one stored.
 */
export function keyNamesAt(parsed: TomlTables, path: string, key: string): string[] {
  const own = parsed.tables.get(`${path}.${key}`);
  if (own !== undefined) return [...own.keys()].sort();
  const inline = parsed.tables.get(path)?.get(key);
  return inline !== undefined && 'keys' in inline ? [...inline.keys] : [];
}
