/**
 * How much a content source is trusted, 0..1. Used by memory feeders for
 * conflict resolution (higher authority wins, ties broken by recency) and by
 * provenance classification. Configuration for a team should override this
 * table, not fork it.
 */
export const SOURCE_AUTHORITY: Record<string, number> = {
  manual: 1.0,
  github_file: 1.0,
  github_commit: 0.95,
  extracted_decision: 0.92,
  github_pull_request: 0.85,
  github_issue: 0.82,
  meetings_message: 0.72,
  document: 0.62,
  slack_message: 0.6,
  discord_message: 0.5,
  email_message: 0.4,
  unknown: 0.3,
};

export const DEFAULT_SOURCE_AUTHORITY = SOURCE_AUTHORITY['unknown'] ?? 0.3;
/** Sources below this authority are untrusted at ingestion. */
export const AUTHORITY_TRUSTED_THRESHOLD = 0.7;

export function authorityOf(sourceType: string | undefined): number {
  if (!sourceType) return DEFAULT_SOURCE_AUTHORITY;
  return SOURCE_AUTHORITY[sourceType] ?? DEFAULT_SOURCE_AUTHORITY;
}
