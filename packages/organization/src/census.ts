import {
  OWNER_STATUS,
  REGISTERED_VIA,
  type CensusEntry,
  type OwnerStatus,
  type RegisteredVia,
} from './subject';

/** One source of agents, and what it can prove about each. */
export interface CensusSource {
  readonly kind: Exclude<RegisteredVia, 'console'>;
  /** Never throws: a source that cannot be read is a gap to report, not a crash. */
  collect(): Promise<CensusEntry[]>;
}

export interface CensusResult {
  entries: CensusEntry[];
  /** Sources that could not be read, so a small number is never mistaken for a clean one. */
  unavailable: string[];
}

/**
 * Four independent sources, and every count links to the record that proved it. A number
 * a security lead cannot drill into is a number they will not repeat to their board.
 */
export async function takeCensus(
  sources: readonly CensusSource[],
): Promise<CensusResult> {
  const entries: CensusEntry[] = [];
  const unavailable: string[] = [];

  for (const source of sources) {
    try {
      entries.push(...(await source.collect()));
    } catch {
      // Reported rather than swallowed: a source nobody could read is the finding.
      unavailable.push(source.kind);
    }
  }
  return { entries: dedupe(entries), unavailable };
}

/**
 * The same agent seen by two sources is one agent. Merged on evidence, and the more
 * specific owner wins, because a named owner beats an inferred one.
 */
function dedupe(entries: readonly CensusEntry[]): CensusEntry[] {
  const byEvidence = new Map<string, CensusEntry>();
  for (const entry of entries) {
    const existing = byEvidence.get(entry.evidence);
    if (existing === undefined) {
      byEvidence.set(entry.evidence, entry);
      continue;
    }
    byEvidence.set(entry.evidence, merge(existing, entry));
  }
  return [...byEvidence.values()];
}

const OWNER_RANK: Record<OwnerStatus, number> = {
  [OWNER_STATUS.UNKNOWN]: 0,
  [OWNER_STATUS.INFERRED]: 1,
  [OWNER_STATUS.NAMED]: 2,
};

function merge(a: CensusEntry, b: CensusEntry): CensusEntry {
  return {
    ...a,
    ...(a.subjectId === undefined && b.subjectId !== undefined
      ? { subjectId: b.subjectId }
      : {}),
    reach: {
      production: a.reach.production || b.reach.production,
      customerData: a.reach.customerData || b.reach.customerData,
      destructive: a.reach.destructive || b.reach.destructive,
    },
    // Governable if any source can hold a seam on it; one that cannot is not the answer.
    governable: a.governable || b.governable,
    ownerStatus:
      OWNER_RANK[b.ownerStatus] > OWNER_RANK[a.ownerStatus]
        ? b.ownerStatus
        : a.ownerStatus,
    firstSeen: a.firstSeen < b.firstSeen ? a.firstSeen : b.firstSeen,
  };
}

/**
 * The gap is the finding: what they were tracking against what is there. It is theirs
 * rather than ours, which is why the number they had is an input.
 */
export function censusGap(entries: readonly CensusEntry[], tracked: number): number {
  return entries.length - tracked;
}

/**
 * Agents inside products the company buys, and agents in infrastructure nobody owns.
 * Naming them as ungovernable is worth more than pretending otherwise.
 */
export function ungovernable(entries: readonly CensusEntry[]): CensusEntry[] {
  return entries.filter((entry) => !entry.governable);
}

/** Every source a census can be taken from. A fifth would be a new kind of evidence. */
export const CENSUS_SOURCES: readonly Exclude<RegisteredVia, 'console'>[] = [
  REGISTERED_VIA.ENROLMENT,
  REGISTERED_VIA.PROVIDER,
  REGISTERED_VIA.PIPELINE,
  REGISTERED_VIA.VENDOR,
];
