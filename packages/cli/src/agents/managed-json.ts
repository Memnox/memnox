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
 * The Memnox entry in a JSON config, edited by span through `jsonc-parser`, because these
 * files are JSONC in practice and a re-serialize would rewrite every line's indentation.
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

const NOT_JSON: RewriteResult = {
  next: null,
  because: 'its config is not JSON this can rewrite',
};

/** The parsed document, tolerant of comments and trailing commas, or null where it will not parse. */
function parsedObject(raw: string): Record<string, unknown> | null {
  const errors: ParseError[] = [];
  const parsed: unknown = parse(raw, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0 || parsed === null || typeof parsed !== 'object') return null;
  // Narrowed to an object on the line above.
  return parsed as Record<string, unknown>;
}

/** One named entry set to `entry`, or removed where it is undefined. */
function editedEntry(
  raw: string,
  serversKey: string,
  name: string,
  entry: unknown,
): RewriteResult {
  try {
    const edits = modify(raw, [serversKey, name], entry, {
      formattingOptions: formattingOf(raw),
    });
    return { next: applyEdits(raw, edits) };
  } catch {
    return NOT_JSON;
  }
}

export function withManagedJsonServer(
  raw: string,
  serversKey: string,
  server: ManagedServer,
): RewriteResult {
  return withJsonEntry(raw, serversKey, MANAGED_SERVER, server);
}

export function withoutManagedJsonServer(raw: string, serversKey: string): RewriteResult {
  return withoutJsonEntry(raw, serversKey, MANAGED_SERVER);
}

/** Any one server by name, so the session server is written by the same span edit. */
export function withJsonEntry(
  raw: string,
  serversKey: string,
  name: string,
  entry: unknown,
): RewriteResult {
  return editedEntry(raw, serversKey, name, entry);
}

export function withoutJsonEntry(
  raw: string,
  serversKey: string,
  name: string,
): RewriteResult {
  const held = jsonServerNames(raw);
  if (held === null) return NOT_JSON;
  // Nothing of ours in it: leave the bytes exactly as they are.
  if (!held.includes(name)) return { next: raw };
  return editedEntry(raw, serversKey, name, undefined);
}

/**
 * Every server this config declares, so a rewrite can be checked against what it
 * replaced. Null where the file will not parse, which is a refusal.
 */
export function jsonServerNames(raw: string): string[] | null {
  const parsed = parsedObject(raw);
  if (parsed === null) return null;
  const key = serversKeyOf(parsed);
  if (key === null) return [];
  const held = parsed[key];
  if (held === null || typeof held !== 'object') return [];
  return Object.keys(held);
}

/** Which key holds the servers, read the same tolerant way the rewrite reads it. */
export function jsonServersKey(raw: string): string | null {
  const parsed = parsedObject(raw);
  return parsed === null ? null : serversKeyOf(parsed);
}
