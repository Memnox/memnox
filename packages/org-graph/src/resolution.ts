import { RESOLUTION_BASIS, type ResolutionBasis } from './source.constants';

/** Where a record came from in the system that holds it. */
export interface ExternalRef {
  sourceId: string;
  externalId: string;
}

export interface Resolvable {
  id: string;
  workspaceId: string;
  externalRef?: ExternalRef;
  /** What the thing is called, used only when no external reference matches. */
  name: string;
}

/**
 * A merge is recorded, never destructive, so a wrong one can be split. Two systems
 * agreeing on a name is not the same certainty as two records sharing an id, and the
 * basis is kept precisely so a person can tell which kind they are looking at.
 */
export interface MergeRecord {
  id: string;
  workspaceId: string;
  /** The record that survived. */
  keptId: string;
  /** The record folded into it. Still readable; a split restores it. */
  mergedId: string;
  basis: ResolutionBasis;
  at: string;
  splitAt?: string;
  splitBy?: string;
}

export type Resolution =
  { merged: true; into: string; basis: ResolutionBasis } | { merged: false };

/**
 * External reference first, then normalised identity. The order matters: an id in the
 * same system is certain, and a name is a guess that happens to be usually right.
 */
export function resolve(
  candidate: Resolvable,
  existing: readonly Resolvable[],
): Resolution {
  const ref = candidate.externalRef;
  if (ref !== undefined) {
    const sameRecord = existing.find(
      (each) =>
        each.id !== candidate.id &&
        each.externalRef !== undefined &&
        each.externalRef.sourceId === ref.sourceId &&
        each.externalRef.externalId === ref.externalId,
    );
    if (sameRecord !== undefined) {
      return { merged: true, into: sameRecord.id, basis: RESOLUTION_BASIS.EXTERNAL_REF };
    }
  }

  const normalised = normalise(candidate.name);
  if (normalised.length === 0) return { merged: false };
  const sameName = existing.find(
    (each) => each.id !== candidate.id && normalise(each.name) === normalised,
  );
  if (sameName === undefined) return { merged: false };
  return { merged: true, into: sameName.id, basis: RESOLUTION_BASIS.IDENTITY };
}

/** A split undoes a merge without deleting the record of it having happened. */
export function split(record: MergeRecord, at: string, by: string): MergeRecord {
  return { ...record, splitAt: at, splitBy: by };
}

export function isSplit(record: MergeRecord): boolean {
  return record.splitAt !== undefined;
}

/** Merges that still stand, which is what a read has to fold through. */
export function standing(records: readonly MergeRecord[]): MergeRecord[] {
  return records.filter((record) => !isSplit(record));
}

/**
 * Case, punctuation and spacing differ between systems that mean the same person or
 * team. Nothing cleverer: a fuzzy match here would merge two real teams silently.
 */
export function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface MergeStore {
  record(merge: MergeRecord): Promise<void>;
  listByWorkspace(workspaceId: string): Promise<MergeRecord[]>;
  findById(id: string): Promise<MergeRecord | null>;
}
