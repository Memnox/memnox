import { parseDocument, parse } from 'yaml';

import { DEFAULT_SERVER_KEY } from '@memnox/core';

import { MANAGED_SERVER, type ManagedServer, type RewriteResult } from './managed-shape';

/**
 * The Memnox entry in a YAML config, edited through `parseDocument`, which keeps the
 * comments, key order and anchors a plain stringify would drop.
 */

const SERVERS_KEY = DEFAULT_SERVER_KEY.yaml;

/** Padding off, or the default rewrites `["a"]` as `[ "a" ]` on lines nothing here touched. */
const WRITE = { flowCollectionPadding: false } as const;

type YamlDocument = ReturnType<typeof parseDocument>;

/** The document, or why it will not be rewritten: one that parsed with errors would be written back wrong. */
function readableDocument(raw: string): YamlDocument | RewriteResult {
  let doc: YamlDocument;
  try {
    doc = parseDocument(raw);
  } catch {
    return { next: null, because: 'its config is not YAML this can rewrite' };
  }
  if (doc.errors.length > 0) {
    return { next: null, because: 'its config has YAML errors this will not rewrite' };
  }
  return doc;
}

function isRefusal(read: YamlDocument | RewriteResult): read is RewriteResult {
  return 'next' in read;
}

export function withManagedYamlServer(raw: string, server: ManagedServer): RewriteResult {
  const doc = readableDocument(raw);
  if (isRefusal(doc)) return doc;
  doc.setIn([SERVERS_KEY, MANAGED_SERVER], {
    url: server.url,
    headers: { ...server.headers },
  });
  return { next: doc.toString(WRITE) };
}

export function withoutManagedYamlServer(raw: string): RewriteResult {
  const doc = readableDocument(raw);
  if (isRefusal(doc)) return doc;
  if (!doc.hasIn([SERVERS_KEY, MANAGED_SERVER])) return { next: raw };
  doc.deleteIn([SERVERS_KEY, MANAGED_SERVER]);
  return { next: doc.toString(WRITE) };
}

/**
 * Every server this config declares, so a rewrite can be checked against what
 * it replaced. Null where the file will not parse, which is a refusal.
 */
export function yamlServerNames(raw: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return [];
  // Narrowed to an object on the line above.
  const held = (parsed as Record<string, unknown>)[SERVERS_KEY];
  if (held === null || typeof held !== 'object') return [];
  return Object.keys(held);
}
