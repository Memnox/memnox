/**
 * A JSON config's server entries rewritten by span, so the rest of the file — its comments,
 * its indentation, every line nobody asked to change — comes back exactly as it was.
 */
import {
  applyEdits,
  findNodeAtLocation,
  getNodeValue,
  modify,
  parse,
  parseTree,
  type ParseError,
} from 'jsonc-parser';
import { canonicalJson } from '@memnox/core';

import { formattingOf } from '../agents/managed-json';

/** One entry's new value, by server name. */
export interface EntryChange {
  name: string;
  after: unknown;
}

/**
 * The document, tolerant of the comments and trailing commas VS Code and Cline write, or
 * null where it will not parse, which is a refusal to touch it.
 */
export function parseJsonc(raw: string): Record<string, unknown> | null {
  const errors: ParseError[] = [];
  const parsed: unknown = parse(raw, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0 || parsed === null || typeof parsed !== 'object') return null;
  // Narrowed to an object on the line above.
  return parsed as Record<string, unknown>;
}

/**
 * `raw` with each entry under `key` set to its new value. `previous` is the file as it was
 * before the last rewrite: where it still holds an entry equal to the new value, that
 * entry's own text is put back, so a wrap and an unwrap return the bytes they started from.
 */
export function withEntries(
  raw: string,
  key: string,
  changes: readonly EntryChange[],
  previous: string | null,
): string {
  let next = raw;
  for (const change of changes) {
    const kept = previous === null ? null : entryText(previous, key, change);
    const restored = kept === null ? null : spliced(next, key, change.name, kept);
    next = restored ?? edited(next, key, change);
  }
  return next;
}

function edited(raw: string, key: string, change: EntryChange): string {
  const edits = modify(raw, [key, change.name], change.after, {
    formattingOptions: formattingOf(raw),
  });
  return applyEdits(raw, edits);
}

/** The entry's text as `previous` wrote it, when its value is the one being set. */
function entryText(previous: string, key: string, change: EntryChange): string | null {
  const tree = parseTree(previous);
  const node =
    tree === undefined ? undefined : findNodeAtLocation(tree, [key, change.name]);
  if (node === undefined) return null;
  // Compared canonically, since key order is the writer's and not part of the value.
  if (canonicalJson(getNodeValue(node)) !== canonicalJson(change.after)) return null;
  return previous.slice(node.offset, node.offset + node.length);
}

/** Null where the entry is not in `raw`, so the caller edits instead of guessing. */
function spliced(raw: string, key: string, name: string, text: string): string | null {
  const tree = parseTree(raw);
  const node = tree === undefined ? undefined : findNodeAtLocation(tree, [key, name]);
  if (node === undefined) return null;
  return `${raw.slice(0, node.offset)}${text}${raw.slice(node.offset + node.length)}`;
}
