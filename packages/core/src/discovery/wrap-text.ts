import {
  parseTomlTables,
  childTablesOf,
  listAt,
  stringAt,
} from './detectors/toml-tables';
import { blockAt, listIn, parseYamlBlocks } from './detectors/yaml-block';
import type { ServerLaunch } from './wrap';

/**
 * Repointing a server declared in TOML or YAML, without reserialising the file.
 *
 * The JSON path can parse, edit and write the whole document back, because JSON holds
 * nothing a round trip would lose. TOML and YAML do: comments, key order, quoting
 * style, blank lines somebody put there on purpose. So these edit the two lines that
 * have to change and copy every other byte through untouched — which is also the only
 * way `unwrap` can put a hand-edited file back the way its author left it.
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
  /** Line index of `command`, and the inclusive span of `args`. Absent means missing. */
  commandLine: number;
  argsFrom: number;
  argsTo: number;
  /** Indent to write a replacement line at, so the file still lines up. */
  indent: string;
  /**
   * How the file already writes these two, so a replacement is written the same way.
   * Unwrap has to leave the file byte for byte as its author had it, and re-quoting a
   * bare scalar or flattening a block list would be a diff nobody asked for.
   */
  quote: QuoteStyle;
  block: boolean;
  /** Indent of a block list's items, kept so the restored list sits where it sat. */
  itemIndent: string;
  /** A TOML array written one item per line ends with a comma; keep that too. */
  trailingComma: boolean;
}

type QuoteStyle = '"' | "'" | 'bare';

/**
 * The servers a text config declares, with the lines that declare them.
 *
 * A server with no `command` is an HTTP upstream. It is named so a caller can say it
 * was skipped, and never rewritten: the wrapped form is a command line, and turning a
 * URL into one would leave the agent unable to start the server at all.
 */
export function readTextServers(
  format: ConfigFormat,
  raw: string,
): { servers: Record<string, ServerLaunch>; urlOnly: string[] } {
  const found = format === CONFIG_FORMAT.TOML ? tomlRegions(raw) : yamlRegions(raw);
  const servers: Record<string, ServerLaunch> = {};
  const urlOnly: string[] = [];
  for (const region of found) {
    if (region.commandLine === -1) {
      urlOnly.push(region.name);
      continue;
    }
    servers[region.name] = region.launch;
  }
  return { servers, urlOnly };
}

/**
 * Rewrites the `command` and `args` of the named servers and nothing else. Lines
 * outside those two are copied through byte for byte, comments included.
 */
export function rewriteTextServers(
  format: ConfigFormat,
  raw: string,
  next: Readonly<Record<string, ServerLaunch>>,
): string {
  const lines = raw.split('\n');
  const regions = (format === CONFIG_FORMAT.TOML ? tomlRegions(raw) : yamlRegions(raw))
    .filter((region) => next[region.name] !== undefined && region.commandLine !== -1)
    // Last first, so an earlier edit never moves the lines a later one points at.
    .sort((a, b) => b.commandLine - a.commandLine);

  for (const region of regions) {
    const launch = next[region.name] as ServerLaunch;
    const toml = format === CONFIG_FORMAT.TOML;
    // TOML has no bare strings, so a value there is always quoted whatever it replaces.
    const style: QuoteStyle = toml ? '"' : region.quote;
    const assign = toml ? ' = ' : ': ';
    const command = `${region.indent}command${assign}${scalar(launch.command, style)}`;

    const argLines = !region.block
      ? [
          `${region.indent}args${assign}[${launch.args
            .map((arg) => scalar(arg, style))
            .join(', ')}]`,
        ]
      : toml
        ? [
            `${region.indent}args = [`,
            ...launch.args.map(
              (arg, at) =>
                `${region.itemIndent}${scalar(arg, style)}${
                  region.trailingComma || at < launch.args.length - 1 ? ',' : ''
                }`,
            ),
            `${region.indent}]`,
          ]
        : [
            `${region.indent}args:`,
            ...launch.args.map((arg) => `${region.itemIndent}- ${scalar(arg, style)}`),
          ];

    // Args first: replacing them cannot move the command line, which is above them.
    if (region.argsFrom === -1) {
      lines.splice(region.commandLine + 1, 0, ...argLines);
    } else {
      lines.splice(region.argsFrom, region.argsTo - region.argsFrom + 1, ...argLines);
    }
    lines[region.commandLine] = command;
  }
  return lines.join('\n');
}

/** Written the way the file already writes them, and quoted anyway when it must be. */
function scalar(value: string, style: QuoteStyle): string {
  if (style === 'bare' && canBeBare(value)) return value;
  if (style === "'" && !value.includes("'")) return `'${value}'`;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Words a YAML parser turns into something that is not a string. Hermes reads this
 * file with a real parser, so writing `- yes` bare would hand it the boolean true and
 * the server would be started with the wrong argument.
 */
const YAML_KEYWORDS = /^(?:y|n|yes|no|true|false|on|off|null|~)$/i;

/** A YAML scalar needs quoting the moment it could be read as anything else. */
function canBeBare(value: string): boolean {
  if (value === '' || /[\s:#,[\]{}'"&*!|>%@`]/.test(value)) return false;
  if (YAML_KEYWORDS.test(value)) return false;
  // A number left bare comes back as a number, which is a different argument.
  return Number.isNaN(Number(value));
}

/** Where the servers live in each format, since no two products agree. */
const TOML_TABLES: readonly string[] = ['mcp_servers', 'mcpServers'];
const YAML_KEYS: readonly string[] = ['mcp_servers', 'mcpServers'];

function tomlRegions(raw: string): ServerRegion[] {
  const parsed = parseTomlTables(raw);
  const lines = raw.split('\n');
  const regions: ServerRegion[] = [];

  for (const table of TOML_TABLES) {
    for (const name of childTablesOf(parsed, table)) {
      const path = `${table}.${name}`;
      const header = headerLine(lines, path);
      if (header === -1) continue;
      // A table ends at the next header, sub-tables like `[x.env]` included: `command`
      // and `args` are only ever written directly under the server's own header.
      let end = lines.length - 1;
      for (let at = header + 1; at < lines.length; at += 1) {
        if ((lines[at] as string).trim().startsWith('[')) {
          end = at - 1;
          break;
        }
      }
      regions.push(
        regionIn(lines, header + 1, end, {
          name,
          command: stringAt(parsed, path, 'command'),
          args: listAt(parsed, path, 'args'),
          assign: /^\s*(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*=/,
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

  for (const key of YAML_KEYS) {
    const block = blockAt(root, key);
    if (block === null) continue;
    const parentLine = keyLine(lines, key, 0);
    if (parentLine === -1) continue;

    for (const [name] of block.children) {
      const start = keyLine(lines, name, parentLine + 1);
      if (start === -1) continue;
      const indent = indentOf(lines[start] as string);
      let end = lines.length - 1;
      for (let at = start + 1; at < lines.length; at += 1) {
        const line = lines[at] as string;
        if (line.trim() === '') continue;
        if (indentOf(line).length <= indent.length) {
          end = at - 1;
          break;
        }
      }
      const entry = block.children.get(name);
      regions.push(
        regionIn(lines, start + 1, end, {
          name,
          command: entry?.children.get('command')?.value ?? null,
          args: listIn(entry?.children.get('args') ?? null),
          assign: /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*:/,
          fallbackIndent: `${indent}  `,
        }),
      );
    }
  }
  return regions;
}

interface RegionSpec {
  name: string;
  command: string | null;
  args: string[];
  /** Matches `key = ` in TOML and `key:` in YAML, capturing the key. */
  assign: RegExp;
  /** Used when the block declares neither line, so an insert still lines up. */
  fallbackIndent: string;
}

/**
 * The `command` line and the `args` span inside one server's block. `args` may run
 * over several lines in either format, so its end is the last line still inside it.
 */
function regionIn(
  lines: readonly string[],
  from: number,
  to: number,
  spec: RegionSpec,
): ServerRegion {
  let commandLine = -1;
  let argsFrom = -1;
  let argsTo = -1;
  let indent = spec.fallbackIndent;
  let quote: QuoteStyle = 'bare';
  let block = false;
  let itemIndent = `${spec.fallbackIndent}  `;
  let trailingComma = false;

  for (let at = from; at <= to && at < lines.length; at += 1) {
    const line = lines[at] as string;
    const match = spec.assign.exec(line);
    if (match === null) continue;
    const key = match[1] ?? match[2] ?? match[3];
    if (key === 'command') {
      commandLine = at;
      indent = indentOf(line);
      quote = quoteOf(line.slice((match.index ?? 0) + match[0].length));
      continue;
    }
    if (key !== 'args') continue;
    argsFrom = at;
    argsTo = at;
    if (indent === spec.fallbackIndent) indent = indentOf(line);
    /* YAML puts its items below an empty key; TOML opens a bracket and keeps going.
       Either way the value did not fit on one line, and putting it back on one would
       be a diff the file's author never asked for. */
    const after = line.slice((match.index ?? 0) + match[0].length).trim();
    block = after === '' || after === '[';
    // Everything indented deeper, or an array still open, belongs to this assignment.
    const own = indentOf(line).length;
    let depth = openBrackets(line);
    for (let next = at + 1; next <= to && next < lines.length; next += 1) {
      const following = lines[next] as string;
      if (following.trim() === '') break;
      if (depth <= 0 && indentOf(following).length <= own) break;
      depth += openBrackets(following);
      const text = following.trim();
      if (block && text.startsWith('- ')) {
        itemIndent = indentOf(following);
        quote = quoteOf(text.slice(2));
      } else if (block && text !== ']' && text !== '') {
        itemIndent = indentOf(following);
        trailingComma = text.endsWith(',');
        quote = quoteOf(text.replace(/,$/, ''));
      }
      argsTo = next;
    }
  }

  return {
    name: spec.name,
    launch: { command: spec.command ?? '', args: [...spec.args] },
    commandLine,
    argsFrom,
    argsTo,
    indent,
    quote,
    block,
    itemIndent,
    trailingComma,
  };
}

function quoteOf(value: string): QuoteStyle {
  const text = value.trim();
  if (text.startsWith('"')) return '"';
  if (text.startsWith("'")) return "'";
  return 'bare';
}

function openBrackets(line: string): number {
  let quote: string | null = null;
  let depth = 0;
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at] as string;
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '[') depth += 1;
    else if (char === ']') depth -= 1;
  }
  return depth;
}

function indentOf(line: string): string {
  return line.slice(0, line.length - line.trimStart().length);
}

/** The line declaring `[a.b]`, quoted or bare, ignoring anything inside a comment. */
function headerLine(lines: readonly string[], path: string): number {
  const segments = path.split('.');
  for (let at = 0; at < lines.length; at += 1) {
    const text = (lines[at] as string).trim();
    if (!text.startsWith('[')) continue;
    const close = text.indexOf(']');
    if (close === -1) continue;
    const header = text
      .slice(1, close)
      .split('.')
      .map((part) => part.trim().replace(/^["']|["']$/g, ''));
    if (header.length === segments.length && header.every((p, i) => p === segments[i])) {
      return at;
    }
  }
  return -1;
}

/** The line declaring a mapping key, from `from` onward. Quoted or bare. */
function keyLine(lines: readonly string[], key: string, from: number): number {
  for (let at = from; at < lines.length; at += 1) {
    const text = (lines[at] as string).trim();
    if (text.startsWith('#') || text.startsWith('-')) continue;
    const colon = text.indexOf(':');
    if (colon <= 0) continue;
    if (
      text
        .slice(0, colon)
        .trim()
        .replace(/^["']|["']$/g, '') === key
    )
      return at;
  }
  return -1;
}

/**
 * Sets a list under a nested key, in place, so a YAML config keeps its comments.
 *
 * Fenced with a marker on the key's own line: a revert takes back exactly the block we
 * wrote, and a list somebody maintains by hand is left alone because it carries no
 * fence. Writing an unfenced list would make an uninstall either destructive or
 * impossible, and both are worse than not writing at all.
 */
export const YAML_FENCE =
  '# memnox: managed — remove with "memnox protect --revert-native"';

export function setYamlList(
  raw: string,
  parent: string,
  key: string,
  items: readonly string[],
): string {
  const lines = raw.split('\n');
  const parentLine = keyLine(lines, parent, 0);

  const block = (indent: string): string[] => [
    `${indent}${key}: ${YAML_FENCE}`,
    ...items.map((item) => `${indent}  - ${scalar(item, '"')}`),
  ];

  if (parentLine === -1) {
    if (items.length === 0) return raw;
    const trailing = raw.endsWith('\n') || raw === '' ? '' : '\n';
    return `${raw}${trailing}${parent}:\n${block('  ').join('\n')}\n`;
  }

  const parentIndent = indentOf(lines[parentLine] as string).length;
  const existing = keyLineWithin(lines, key, parentLine + 1, parentIndent);

  if (existing === -1) {
    if (items.length === 0) return raw;
    lines.splice(parentLine + 1, 0, ...block(`${' '.repeat(parentIndent)}  `));
    return lines.join('\n');
  }

  // The key's own line plus everything indented under it is the value being replaced.
  const own = indentOf(lines[existing] as string);
  let end = existing;
  for (let at = existing + 1; at < lines.length; at += 1) {
    const line = lines[at] as string;
    if (line.trim() === '') break;
    if (indentOf(line).length <= own.length) break;
    end = at;
  }
  const replacement = items.length === 0 ? [] : block(own);
  lines.splice(existing, end - existing + 1, ...replacement);

  /* Taking the list out can leave the parent behind with nothing under it. We may have
     created that parent, and a revert that leaves a bare `approvals:` has not put the
     file back — so an empty parent goes with the last child that needed it. */
  if (replacement.length === 0 && !hasChildren(lines, parentLine, parentIndent)) {
    lines.splice(parentLine, 1);
  }
  return lines.join('\n');
}

/** Any line still indented under the parent, ignoring blanks. */
function hasChildren(
  lines: readonly string[],
  parentLine: number,
  parentIndent: number,
): boolean {
  for (let at = parentLine + 1; at < lines.length; at += 1) {
    const line = lines[at] as string;
    if (line.trim() === '') continue;
    if (indentOf(line).length <= parentIndent) return false;
    return true;
  }
  return false;
}

/** Whether the list that is there is ours, so a revert never removes somebody else's. */
export function yamlListIsManaged(raw: string, parent: string, key: string): boolean {
  const lines = raw.split('\n');
  const parentLine = keyLine(lines, parent, 0);
  if (parentLine === -1) return false;
  const at = keyLineWithin(
    lines,
    key,
    parentLine + 1,
    indentOf(lines[parentLine] as string).length,
  );
  return at !== -1 && (lines[at] as string).includes(YAML_FENCE);
}

/** A key inside one parent block: deeper than the parent, and before the next sibling. */
function keyLineWithin(
  lines: readonly string[],
  key: string,
  from: number,
  parentIndent: number,
): number {
  for (let at = from; at < lines.length; at += 1) {
    const line = lines[at] as string;
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (indentOf(line).length <= parentIndent) return -1;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    if (
      line
        .slice(0, colon)
        .trim()
        .replace(/^["\']|["\']$/g, '') === key
    )
      return at;
  }
  return -1;
}
