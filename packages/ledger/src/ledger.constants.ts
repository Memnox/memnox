/** Not only the verdict: one session, one timeline, reconstructed from rows. */
export const FRAME_KIND = {
  INTENT: 'intent',
  RETRIEVAL: 'retrieval',
  CAPABILITY: 'capability',
  TOOL_CALL: 'tool_call',
  VERDICT: 'verdict',
  RESULT: 'result',
  SIDE_EFFECT: 'side_effect',
} as const;

export type FrameKind = (typeof FRAME_KIND)[keyof typeof FRAME_KIND];

/**
 * Full fidelity on anything withheld or escalated, sampled on the allowed majority,
 * which is where the bytes are. A laptop is not a warehouse.
 */
export const DEFAULT_ALLOW_SAMPLE_RATE = 0.05;
export const DEFAULT_RETENTION_DAYS = 30;

/** How a lineage hop was established. An inferred hop pretending otherwise is worse than a gap. */
export const LINEAGE_METHOD = {
  /** A correlation id was carried and read back. */
  PROPAGATED: 'propagated',
  /** A system asserted it, e.g. a pipeline's OIDC claim. */
  CLAIMED: 'claimed',
  /** Nothing was carried; actor, resource and time were joined. */
  INFERRED: 'inferred',
} as const;

export type LineageMethod = (typeof LINEAGE_METHOD)[keyof typeof LINEAGE_METHOD];

export const LINEAGE_CONFIDENCE: Record<LineageMethod, number> = {
  [LINEAGE_METHOD.PROPAGATED]: 1,
  [LINEAGE_METHOD.CLAIMED]: 0.8,
  [LINEAGE_METHOD.INFERRED]: 0.4,
};

/** A counterfactual is derived from the attempt that was made, and from nothing else. */
export const COUNTERFACTUAL_BASIS = 'observed_attempt';

/** The correlation id travels in commit trailers, PR bodies and pipeline claims. */
export const CORRELATION_TRAILER = 'Memnox-Correlation-Id';
