import {
  applyEdits,
  modify,
  parse,
  type FormattingOptions,
  type ParseError,
} from 'jsonc-parser';
import { serversKeyOf } from '@memnox/core';
import { MANAGED_SERVER, type ManagedServer, type RewriteResult } from './managed-shape';

/**
 * The Memnox entry in a JSON config, edited in place.
 *
 * Through `jsonc-parser` rather than `JSON.parse` and `JSON.stringify`, for two
 * reasons that both cost real machines.
 *
 * **Comments.** VS Code's `mcp.json` and Cline's settings are JSONC in practice,
 * and `JSON.parse` throws on the first `//`. A person with one comment in their
 * config was told their agent could not be managed, which is the same gap TOML
 * and YAML had and the least excusable of the three: JSON was the format this
 * claimed to support.
 *
 * **Formatting.** A re-serialize rewrites every line of the file. A config
 * written with four-space indent came back with two, so onboarding produced a
 * diff touching a hundred lines to add four, and a reviewer had to read all of
 * it to find the change. The library edits the span that changes and leaves the
 * rest of the bytes alone, which is what TOML and YAML already do here.
 */

/** The indentation this file already uses, so an insert matches what surrounds it. */
function formattingOf(raw: string): FormattingOptions {
  const indented = /^([ \t]+)\S/m.exec(raw);
  const found = indented?.[1] ?? '  ';
  const insertSpaces = !found.startsWith('\t');
  return {
    insertSpaces,
    tabSize: insertSpaces ? found.length : 1,
    eol: raw.includes('\r\n') ? '\r\n' : '\n',
  };
}

export function withManagedJsonServer(
  raw: string,
  serversKey: string,
  server: ManagedServer,
): RewriteResult {
  try {
    const edits = modify(raw, [serversKey, MANAGED_SERVER], server, {
      formattingOptions: formattingOf(raw),
    });
    return { next: applyEdits(raw, edits) };
  } catch {
    return { next: null, because: 'its config is not JSON this can rewrite' };
  }
}

export function withoutManagedJsonServer(raw: string, serversKey: string): RewriteResult {
  const held = jsonServerNames(raw);
  if (held === null) {
    return { next: null, because: 'its config is not JSON this can rewrite' };
  }
  // Nothing of ours in it: leave the bytes exactly as they are.
  if (!held.includes(MANAGED_SERVER)) return { next: raw };

  try {
    const edits = modify(raw, [serversKey, MANAGED_SERVER], undefined, {
      formattingOptions: formattingOf(raw),
    });
    return { next: applyEdits(raw, edits) };
  } catch {
    return { next: null, because: 'its config is not JSON this can rewrite' };
  }
}

/**
 * Every server this config declares, so a rewrite can be checked against what
 * it replaced. Null where the file will not parse, which is a refusal.
 *
 * Tolerant of comments and trailing commas, because the files this reads are
 * ones people edit by hand in an editor that allows both.
 */
export function jsonServerNames(raw: string): string[] | null {
  const errors: ParseError[] = [];
  const parsed: unknown = parse(raw, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) return null;
  if (parsed === null || typeof parsed !== 'object') return null;

  const key = serversKeyOf(parsed as Record<string, unknown>);
  if (key === null) return [];
  const held = (parsed as Record<string, unknown>)[key];
  if (held === null || typeof held !== 'object') return [];
  return Object.keys(held as Record<string, unknown>);
}

/** Which key holds the servers, read the same tolerant way the rewrite reads it. */
export function jsonServersKey(raw: string): string | null {
  const errors: ParseError[] = [];
  const parsed: unknown = parse(raw, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0 || parsed === null || typeof parsed !== 'object') return null;
  return serversKeyOf(parsed as Record<string, unknown>);
}
