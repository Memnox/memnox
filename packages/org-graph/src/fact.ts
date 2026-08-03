import { STATED_PROVENANCE } from './org-graph.constants';
import { isBinding, mayRead, type Stated } from './stated';

/** One thing the organization is willing to tell a particular caller. */
export interface Fact {
  id: string;
  sourceType: string;
  sourceRef?: string;
  author?: string;
  occurredAt: string;
  content: string;
  /** Untrusted provenance. Never strip this before showing it to a model. */
  tainted: boolean;
}

/** What a reader got, and how much bearing evidence it did not. */
export interface ReadableFacts {
  facts: Fact[];
  /**
   * How many binding statements were withheld from this reader.
   *
   * Counted rather than named, and that is the point: a caller learns its
   * answer is partial without learning what it is missing, which is the only
   * way to report incompleteness without the count becoming a channel for the
   * content it is hiding.
   */
  withheld: number;
}

/**
 * A statement as a caller may see it.
 *
 * `tainted` is provenance, not quality: anything a machine read out of a
 * conversation carries it, because a model about to consume this cannot tell
 * a company's decision from a sentence somebody typed into a channel.
 */
export function factFromStated(stated: Stated): Fact {
  return {
    id: stated.id,
    sourceType: stated.kind,
    ...(stated.sourceRef === undefined ? {} : { sourceRef: stated.sourceRef }),
    ...(stated.verifiedBy === undefined ? {} : { author: stated.verifiedBy }),
    occurredAt: stated.effectiveFrom ?? stated.detectedAt,
    content: stated.statement,
    tainted: stated.provenance === STATED_PROVENANCE.OBSERVED,
  };
}

/**
 * The statements one reader may be told, and the count of the ones it may not.
 *
 * Clearance is applied after binding, never before: a candidate nobody has
 * confirmed is not withheld from the caller, it simply is not yet something the
 * organization says. Counting it would make the withheld number a measure of
 * how much unverified text is sitting in the store.
 */
export function readableFacts(
  statements: readonly Stated[],
  reader: string | undefined,
  now: Date,
): ReadableFacts {
  const binding = statements.filter((stated) => isBinding(stated, now));
  const readable = binding.filter((stated) => mayRead(stated, reader));
  return {
    facts: readable.map(factFromStated),
    withheld: binding.length - readable.length,
  };
}
