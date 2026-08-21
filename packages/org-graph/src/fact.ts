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
  /** Counted, never named: a caller learns its answer is partial, not what it missed. */
  withheld: number;
}

/** `tainted` is provenance, not quality — anything machine-read out of a conversation. */
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

/** Clearance is applied after binding: an unconfirmed candidate is not a fact. */
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
