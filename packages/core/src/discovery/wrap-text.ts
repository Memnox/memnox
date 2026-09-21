import {
  indentOf,
  keyLine,
  keyNameOf,
  scalarText,
  type QuoteStyle,
} from './config-lines';
import {
  childTablesOf,
  listAt,
  parseTomlTables,
  stringAt,
} from './detectors/toml-tables';
import { blockAt, listIn, parseYamlBlocks } from './detectors/yaml-block';
import { TOML_SERVER_TABLES, YAML_SERVER_KEYS } from './mcp-keys';
import { openBrackets } from './scalar-text';
import type { ServerLaunch } from './wrap';

/**
 * Repointing a server declared in TOML or YAML without reserialising the file, so the
 * two lines that change are edited and every other byte, comments included, is copied.
 */
export const CONFIG_FORMAT = {
  JSON: 'json',
  TOML: 'toml',
  YAML: 'yaml',
} as const;

export type ConfigFormat = (typeof CONFIG_FORMAT)[keyof typeof CONFIG_FORMAT];

export function formatOf(path: string): ConfigFormat {
  if (path.endsWith('.toml')) return CONFIG_FORMAT.TOML;
  if (path.endsWith('.yaml') || path.endsWith('.yml')) return CONFIG_FORMAT.YAML;
  return CONFIG_FORMAT.JSON;
}

/** Where a server's launch lines live in the file, so an edit knows what to replace. */
interface ServerRegion {
  name: string;
  launch: ServerLaunch;
  /** Line index of `command`, and the inclusive span of `args`. -1 means missing. */
  commandLine: number;
  argsFrom: number;
  argsTo: number;
  /** Indent to write a replacement line at, so the file still lines up. */
  indent: string;
  /** How the file quotes these, because unwrap has to leave the file byte for byte. */
  quote: QuoteStyle;
  /** True when `args` spans several lines, which a replacement keeps. */
  block: boolean;
  /** Indent of a block list's items, kept so the restored list sits where it sat. */
  itemIndent: string;
  /** A TOML array written one item per line ends with a comma; keep that too. */
  trailingComma: boolean;
}

/** Matches `key = ` in TOML and `key:` in YAML, capturing the key quoted or bare. */
const TOML_ASSIGN = /^\s*(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*=/;
const YAML_ASSIGN = /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*:/;

/**
 * The servers a text config declares. A server with no `command` is an HTTP upstream,
 * named so a caller can report it skipped, and never rewritten.
 */
export function readTextServers(
  format: ConfigFormat,
  raw: string,
): { servers: Record<string, ServerLaunch>; urlOnly: string[] } {
  const servers: Record<string, ServerLaunch> = {};
  const urlOnly: string[] = [];
  for (const region of regionsOf(format, raw)) {
    if (region.commandLine === -1) urlOnly.push(region.name);
    else servers[region.name] = region.launch;
  }
  return { servers, urlOnly };
}

/** Rewrites the `command` and `args` of the named servers, and copies every other line. */
export function rewriteTextServers(
  format: ConfigFormat,
  raw: string,
  next: Readonly<Record<string, ServerLaunch>>,
): string {
  const lines = raw.split('\n');
  const regions = regionsOf(format, raw)
    .filter((region) => next[region.name] !== undefined && region.commandLine !== -1)
    // Last first, so an earlier edit never moves the lines a later one points at.
    .sort((a, b) => b.commandLine - a.commandLine);

  for (const region of regions) {
    // Filtered above to the names `next` holds.
    const launch = next[region.name] as ServerLaunch;
    const argLines = argLinesFor(format, region, launch.args);
    // Args first: replacing them cannot move the command line, which is above them.
    if (region.argsFrom === -1) lines.splice(region.commandLine + 1, 0, ...argLines);
    else lines.splice(region.argsFrom, region.argsTo - region.argsFrom + 1, ...argLines);
    const { style, assign } = syntaxOf(format, region);
    lines[region.commandLine] =
      `${region.indent}command${assign}${scalarText(launch.command, style)}`;
  }
  return lines.join('\n');
}

/** TOML has no bare strings, so a value there is always quoted whatever it replaces. */
function syntaxOf(
  format: ConfigFormat,
  region: ServerRegion,
): { style: QuoteStyle; assign: string } {
  if (format === CONFIG_FORMAT.TOML) return { style: '"', assign: ' = ' };
  return { style: region.quote, assign: ': ' };
}

/** The `args` lines, on one line or across several as the file already had them. */
function argLinesFor(
  format: ConfigFormat,
  region: ServerRegion,
  args: readonly string[],
): string[] {
  const { style, assign } = syntaxOf(format, region);
  const quoted = args.map((arg) => scalarText(arg, style));
  if (!region.block) return [`${region.indent}args${assign}[${quoted.join(', ')}]`];
  if (format === CONFIG_FORMAT.TOML) {
    const comma = (at: number): string =>
      region.trailingComma || at < quoted.length - 1 ? ',' : '';
    return [
      `${region.indent}args = [`,
      ...quoted.map((arg, at) => `${region.itemIndent}${arg}${comma(at)}`),
      `${region.indent}]`,
    ];
  }
  return [
    `${region.indent}args:`,
    ...quoted.map((arg) => `${region.itemIndent}- ${arg}`),
  ];
}

function regionsOf(format: ConfigFormat, raw: string): ServerRegion[] {
  return format === CONFIG_FORMAT.TOML ? tomlRegions(raw) : yamlRegions(raw);
}

function tomlRegions(raw: string): ServerRegion[] {
  const parsed = parseTomlTables(raw);
  const lines = raw.split('\n');
  const regions: ServerRegion[] = [];
  for (const table of TOML_SERVER_TABLES) {
    for (const name of childTablesOf(parsed, table)) {
      const path = `${table}.${name}`;
      const header = headerLine(lines, path);
      if (header === -1) continue;
      const span = { lines, from: header + 1, to: tableEnd(lines, header) };
      regions.push(
        regionIn(span, {
          name,
          command: stringAt(parsed, path, 'command'),
          args: listAt(parsed, path, 'args'),
          assign: TOML_ASSIGN,
          fallbackIndent: '',
        }),
      );
    }
  }
  return regions;
}

function yamlRegions(raw: string): ServerRegion[] {
  const root = parseYamlBlocks(raw);
  const lines = raw.split('\n');
  const regions: ServerRegion[] = [];
  for (const key of YAML_SERVER_KEYS) {
    const block = blockAt(root, key);
    const parentLine = keyLine(lines, key, 0);
    if (block === null || parentLine === -1) continue;
    for (const [name, entry] of block.children) {
      const start = keyLine(lines, name, parentLine + 1);
      if (start === -1) continue;
      const indent = indentOf(lines[start] as string);
      const span = { lines, from: start + 1, to: entryEnd(lines, start) };
      regions.push(
        regionIn(span, {
          name,
          command: entry.children.get('command')?.value ?? null,
          args: listIn(entry.children.get('args') ?? null),
          assign: YAML_ASSIGN,
          fallbackIndent: `${indent}  `,
        }),
      );
    }
  }
  return regions;
}

/** A table ends at the next header, sub-tables included: `command` sits under its own. */
function tableEnd(lines: readonly string[], header: number): number {
  for (let at = header + 1; at < lines.length; at += 1) {
    if ((lines[at] as string).trim().startsWith('[')) return at - 1;
  }
  return lines.length - 1;
}

/** A YAML entry ends at the next line indented no deeper than its key, blanks aside. */
function entryEnd(lines: readonly string[], start: number): number {
  const indent = indentOf(lines[start] as string).length;
  for (let at = start + 1; at < lines.length; at += 1) {
    const line = lines[at] as string;
    if (line.trim() !== '' && indentOf(line).length <= indent) return at - 1;
  }
  return lines.length - 1;
}

/** The lines of one server's block, from `from` to `to` inclusive. */
interface LineSpan {
  lines: readonly string[];
  from: number;
  to: number;
}

interface RegionSpec {
  name: string;
  command: string | null;
  args: string[];
  assign: RegExp;
  /** Used when the block declares neither line, so an insert still lines up. */
  fallbackIndent: string;
}

/** The `command` line and the `args` span inside one server's block. */
function regionIn(span: LineSpan, spec: RegionSpec): ServerRegion {
  const region: ServerRegion = {
    name: spec.name,
    launch: { command: spec.command ?? '', args: [...spec.args] },
    commandLine: -1,
    argsFrom: -1,
    argsTo: -1,
    indent: spec.fallbackIndent,
    quote: 'bare',
    block: false,
    itemIndent: `${spec.fallbackIndent}  `,
    trailingComma: false,
  };
  for (let at = span.from; at <= lastLineOf(span); at += 1) {
    const line = span.lines[at] as string;
    const assignment = assignmentIn(line, spec.assign);
    if (assignment?.key === 'command') {
      region.commandLine = at;
      region.indent = indentOf(line);
      region.quote = quoteOf(assignment.value);
    } else if (assignment?.key === 'args') {
      if (region.indent === spec.fallbackIndent) region.indent = indentOf(line);
      readArgs(region, { ...span, from: at }, assignment.value);
    }
  }
  return region;
}

function lastLineOf(span: LineSpan): number {
  return Math.min(span.to, span.lines.length - 1);
}

function assignmentIn(
  line: string,
  assign: RegExp,
): { key: string | undefined; value: string } | null {
  const match = assign.exec(line);
  if (match === null) return null;
  return {
    key: match[1] ?? match[2] ?? match[3],
    value: line.slice(match.index + match[0].length),
  };
}

/** The `args` span from its key line: deeper lines, or an array still open, belong to it. */
function readArgs(region: ServerRegion, span: LineSpan, value: string): void {
  const line = span.lines[span.from] as string;
  region.argsFrom = span.from;
  region.argsTo = span.from;
  // YAML lists below an empty key and TOML opens a bracket, and either way the value
  // stays on its own lines rather than being folded back onto one.
  const after = value.trim();
  region.block = after === '' || after === '[';
  const own = indentOf(line).length;
  let depth = openBrackets(line);
  for (let next = span.from + 1; next <= lastLineOf(span); next += 1) {
    const following = span.lines[next] as string;
    if (following.trim() === '') break;
    if (depth <= 0 && indentOf(following).length <= own) break;
    depth += openBrackets(following);
    if (region.block) readArgItem(region, following);
    region.argsTo = next;
  }
}

/** Keeps how a block list writes its items: indent, quoting and a trailing comma. */
function readArgItem(region: ServerRegion, line: string): void {
  const text = line.trim();
  if (text.startsWith('- ')) {
    region.itemIndent = indentOf(line);
    region.quote = quoteOf(text.slice(2));
    return;
  }
  if (text === ']' || text === '') return;
  region.itemIndent = indentOf(line);
  region.trailingComma = text.endsWith(',');
  region.quote = quoteOf(text.replace(/,$/, ''));
}

function quoteOf(value: string): QuoteStyle {
  const text = value.trim();
  if (text.startsWith('"')) return '"';
  if (text.startsWith("'")) return "'";
  return 'bare';
}

/** The line declaring `[a.b]`, quoted or bare, ignoring anything inside a comment. */
function headerLine(lines: readonly string[], path: string): number {
  const segments = path.split('.');
  for (let at = 0; at < lines.length; at += 1) {
    const text = (lines[at] as string).trim();
    if (!text.startsWith('[')) continue;
    const close = text.indexOf(']');
    if (close === -1) continue;
    const header = text.slice(1, close).split('.').map(keyNameOf);
    if (header.length === segments.length && header.every((p, i) => p === segments[i])) {
      return at;
    }
  }
  return -1;
}
