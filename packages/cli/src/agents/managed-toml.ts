import { parse } from 'smol-toml';

import { TOML_SERVER_TABLES } from '@memnox/core';

import { MANAGED_SERVER, type ManagedServer, type RewriteResult } from './managed-shape';

/**
 * The Memnox entry in a TOML config, appended and cut as text rather than re-serialized,
 * because a `[header]` ends whichever table was open and so every original byte survives.
 */

const TABLES: readonly string[] = TOML_SERVER_TABLES;

/** The spelling this file already uses, since Codex accepts either, or the modern one for a file with neither. */
function tableIn(raw: string): string {
  for (const table of TABLES) {
    if (new RegExp(`^\\s*\\[\\s*${table}\\s*[.\\]]`, 'm').test(raw)) return table;
  }
  // TOML_SERVER_TABLES is a non-empty constant.
  return TABLES[0] as string;
}

/** Basic TOML string: the only two characters that can end one early. */
function quoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function withManagedTomlServer(raw: string, server: ManagedServer): RewriteResult {
  const table = tableIn(raw);
  // Removed first, because two tables with the same name is not valid TOML.
  const stripped = withoutManagedTomlServer(raw);
  if (stripped.next === null) return stripped;

  const body = stripped.next.replace(/\s*$/, '\n');
  const headers = Object.entries(server.headers)
    .map(([name, value]) => `${name} = ${quoted(value)}`)
    .join('\n');

  const entry =
    `\n[${table}.${MANAGED_SERVER}]\n` +
    `url = ${quoted(server.url)}\n` +
    (headers === '' ? '' : `\n[${table}.${MANAGED_SERVER}.http_headers]\n${headers}\n`);

  return { next: body + entry };
}

/** A server started by command, such as the session server, appended the same way. */
export function withTomlStdioServer(
  raw: string,
  name: string,
  launch: { command: string; args: readonly string[] },
): RewriteResult {
  const table = tableIn(raw);
  const stripped = withoutManagedTomlServer(raw, name);
  if (stripped.next === null) return stripped;
  const body = stripped.next.trim() === '' ? '' : stripped.next.replace(/\s*$/, '\n\n');
  const args = launch.args.map(quoted).join(', ');
  return {
    next: `${body}[${table}.${name}]\ncommand = ${quoted(launch.command)}\nargs = [${args}]\n`,
  };
}

/**
 * Cuts the managed table back out, and any sub-table belonging to it: from its header
 * to the next one that is not its child.
 */
export function withoutManagedTomlServer(
  raw: string,
  name: string = MANAGED_SERVER,
): RewriteResult {
  const lines = raw.split('\n');
  const kept: string[] = [];
  let dropping = false;

  for (const line of lines) {
    const header = /^\s*\[\s*([^\]]+?)\s*\]/.exec(line);
    if (header !== null) {
      // The capture group is not optional, so a match always holds it.
      const path = header[1] as string;
      dropping = TABLES.some(
        (table) => path === `${table}.${name}` || path.startsWith(`${table}.${name}.`),
      );
    }
    if (!dropping) kept.push(line);
  }
  if (kept.length === lines.length) return { next: raw };
  return {
    next: `${kept
      .join('\n')
      .replace(/\n{3,}$/, '\n\n')
      .replace(/\s*$/, '\n')}`,
  };
}

/**
 * Every server this config declares, so a rewrite can be checked against what
 * it replaced. Null where the file will not parse, which is a refusal.
 */
export function tomlServerNames(raw: string): string[] | null {
  let parsed: Record<string, unknown>;
  try {
    // A TOML document always parses to a table.
    parsed = parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const names = new Set<string>();
  for (const table of TABLES) {
    const held = parsed[table];
    if (held === null || typeof held !== 'object') continue;
    for (const name of Object.keys(held)) names.add(name);
  }
  return [...names];
}
