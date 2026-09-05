/**
 * What this repository already says about itself, read through a CLI the reader is
 * already logged into. `why` prints it beside a refusal so the rule is not the only
 * thing standing behind the answer — branch protection is a fact somebody else set.
 */

export interface RepoEvidence {
  /** Required approving reviews, when the forge reports one. */
  requiredReviews?: number;
  /** True when the branch is protected at all. */
  protected?: boolean;
  /** Present when CODEOWNERS covers the path in question. */
  codeowners?: string;
  /** Where it came from and when, because cached evidence must say it is cached. */
  source: string;
  fetchedAt: string;
}

/** Minutes. Long enough that `why` is instant, short enough to still be true. */
export const EVIDENCE_TTL_MINUTES = 10;

export function isFresh(evidence: RepoEvidence, now: Date): boolean {
  const age = now.getTime() - Date.parse(evidence.fetchedAt);
  return age < EVIDENCE_TTL_MINUTES * 60_000;
}

interface ProtectionPayload {
  required_pull_request_reviews?: { required_approving_review_count?: number };
}

/**
 * Parsed rather than trusted: the payload is somebody else's JSON, and a missing field
 * means unknown rather than zero. Reporting "0 required reviews" about a branch whose
 * protection we could not read would be the reassurance this must never give.
 */
export function readProtection(
  raw: string,
  source: string,
  at: string,
): RepoEvidence | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON — gh prints an error here when the branch is unprotected.
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const payload = parsed as ProtectionPayload;
  const reviews = payload.required_pull_request_reviews?.required_approving_review_count;

  return {
    protected: true,
    ...(typeof reviews === 'number' ? { requiredReviews: reviews } : {}),
    source,
    fetchedAt: at,
  };
}

/** Finds the CODEOWNERS entry covering a path, or null. Read from the file, not guessed. */
export function codeownersFor(contents: string, path: string): string | null {
  for (const line of contents.split('\n')) {
    const text = line.trim();
    if (text === '' || text.startsWith('#')) continue;
    const [pattern, ...owners] = text.split(/\s+/);
    if (pattern === undefined || owners.length === 0) continue;

    const prefix = pattern.replace(/\/?\*+$/, '').replace(/^\//, '');
    if (prefix === '' || path.startsWith(prefix)) {
      return `${pattern} → ${owners.join(' ')}`;
    }
  }
  return null;
}

export function describeEvidence(evidence: RepoEvidence): string[] {
  const lines: string[] = [];
  if (evidence.requiredReviews !== undefined) {
    lines.push(
      `branch protection: ${evidence.requiredReviews} required review(s) (${evidence.source})`,
    );
  } else if (evidence.protected === true) {
    lines.push(`branch protection is on (${evidence.source})`);
  }
  if (evidence.codeowners !== undefined) {
    lines.push(`CODEOWNERS: ${evidence.codeowners}`);
  }
  return lines;
}
