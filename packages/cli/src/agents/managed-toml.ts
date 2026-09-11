import { parse } from 'smol-toml';
import { MANAGED_SERVER, type ManagedServer, type RewriteResult } from './managed-shape';

/**
 * The Memnox entry in a TOML config, added and removed as text.
 *
 * Never parsed and re-serialized. `smol-toml` reads TOML and writes it back
 * without the comments, the ordering or the spacing somebody put there, so a
 * round-trip through it would hand back a file that means the same thing and
 * looks nothing like the one they wrote. Appending a table is valid TOML
 * whatever came before it, because a `[header]` ends whichever table was open,
 * so every original byte survives untouched.
 *
 * Codex is the config this is for. It accepts either spelling of the servers
 * table, so whichever the file already uses is the one that gets the entry.
 */

const TABLES: readonly string[] = ['mcp_servers', 'mcpServers'];

/** The spelling this file already uses, or the modern one for a file with neither. */
function tableIn(raw: string): string {
  for (const table of TABLES) {
    if (new RegExp(`^\\s*\\[\\s*${table}\\s*[.\\]]`, 'm').test(raw)) return table;
  }
  return TABLES[0] as string;
}

/** Basic TOML string: the only two characters that can end one early. */
function quoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function withManagedTomlServer(raw: string, server: ManagedServer): RewriteResult {
  const table = tableIn(raw);
  /* Removed first, so onboarding twice replaces its own entry rather than
     leaving two tables with the same name, which is not valid TOML at all. */
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

/**
 * Cuts the managed table back out, and any sub-table belonging to it.
 *
 * From its own header to the next header that is not one of its children, so
 * `[mcp_servers.memnox.http_headers]` goes with it and `[mcp_servers.github]`
 * does not.
 */
export function withoutManagedTomlServer(raw: string): RewriteResult {
  const lines = raw.split('\n');
  const kept: string[] = [];
  let dropping = false;

  for (const line of lines) {
    const header = /^\s*\[\s*([^\]]+?)\s*\]/.exec(line);
    if (header !== null) {
      const path = header[1] as string;
      dropping = TABLES.some(
        (table) =>
          path === `${table}.${MANAGED_SERVER}` ||
          path.startsWith(`${table}.${MANAGED_SERVER}.`),
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
    parsed = parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const names = new Set<string>();
  for (const table of TABLES) {
    const held = parsed[table];
    if (held === null || typeof held !== 'object') continue;
    for (const name of Object.keys(held as Record<string, unknown>)) names.add(name);
  }
  return [...names];
}
