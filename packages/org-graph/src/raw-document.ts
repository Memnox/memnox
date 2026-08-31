import { createHash } from 'node:crypto';

/**
 * What a connector actually read, kept verbatim. An extractor improves, and yesterday's
 * pass has to be redoable against the same input — re-reading the source would give a
 * different answer, and then nobody could tell an extractor change from a source change.
 */
export interface RawDocument {
  id: string;
  sourceId: string;
  workspaceId: string;
  /** The id in the system it came from, which is what a re-read matches on. */
  externalId: string;
  /** What kind of thing it is there: "message", "issue", "page", "file". */
  kind: string;
  content: string;
  /** A permalink, so a citation points somewhere a person can open. */
  url?: string;
  author?: string;
  createdAt?: string;
  fetchedAt: string;
  /** Skips re-extraction when a re-read returned the same bytes. */
  contentHash: string;
}

export interface RawDocumentStore {
  put(document: RawDocument): Promise<void>;
  findByExternalId(sourceId: string, externalId: string): Promise<RawDocument | null>;
  listBySource(sourceId: string, since?: string): Promise<RawDocument[]>;
  /** Removing a source removes what it wrote, because what was read is removable. */
  deleteBySource(sourceId: string): Promise<number>;
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export function newRawDocument(
  input: Omit<RawDocument, 'id' | 'contentHash'> & { id?: string },
): RawDocument {
  return {
    ...input,
    // Deterministic, so a re-read of the same document overwrites rather than duplicates.
    id: input.id ?? `raw_${hashContent(`${input.sourceId}|${input.externalId}`)}`,
    contentHash: hashContent(input.content),
  };
}

/** True when a re-read returned the same bytes, so extraction can be skipped. */
export function isUnchanged(
  existing: RawDocument | null,
  incoming: RawDocument,
): boolean {
  if (existing === null) return false;
  return existing.contentHash === incoming.contentHash;
}
