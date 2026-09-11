import { parseDocument, parse } from 'yaml';
import { MANAGED_SERVER, type ManagedServer, type RewriteResult } from './managed-shape';

/**
 * The Memnox entry in a YAML config, edited in place.
 *
 * Through `parseDocument` rather than `parse` and `stringify`, because the
 * document keeps the comments, the key order and the anchors somebody wrote and
 * writes them back out. A plain parse-and-stringify would hand back a file that
 * means the same thing and has lost every comment in it, and a Hermes config is
 * a file people edit by hand.
 *
 * Indentation is why this cannot be the text append that TOML gets: a nested
 * mapping has no header that closes the block above it.
 */

const SERVERS_KEY = 'mcp_servers';

/**
 * How the document is written back.
 *
 * `flowCollectionPadding` off because the default turns `["a"]` into `[ "a" ]`
 * on lines nothing here touched, which is a diff somebody has to read and
 * explain for an edit that never happened.
 */
const WRITE = { flowCollectionPadding: false } as const;

export function withManagedYamlServer(raw: string, server: ManagedServer): RewriteResult {
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(raw);
  } catch {
    return { next: null, because: 'its config is not YAML this can rewrite' };
  }
  if (doc.errors.length > 0) {
    /* A document that parsed with errors is one this would write back wrong.
       Never rewrite what we could not read back. */
    return { next: null, because: 'its config has YAML errors this will not rewrite' };
  }

  doc.setIn([SERVERS_KEY, MANAGED_SERVER], {
    url: server.url,
    headers: { ...server.headers },
  });
  return { next: doc.toString(WRITE) };
}

export function withoutManagedYamlServer(raw: string): RewriteResult {
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(raw);
  } catch {
    return { next: null, because: 'its config is not YAML this can rewrite' };
  }
  if (doc.errors.length > 0) {
    return { next: null, because: 'its config has YAML errors this will not rewrite' };
  }
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
  const held = (parsed as Record<string, unknown>)[SERVERS_KEY];
  if (held === null || typeof held !== 'object') return [];
  return Object.keys(held as Record<string, unknown>);
}
