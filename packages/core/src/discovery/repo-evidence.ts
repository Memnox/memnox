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
  /**
   * The open pull request for this branch, when there is one.
   *
   * "Technically it can, and the change is not approved" is the commonest honest
   * refusal there is, and it is answerable on a laptop: the forge already knows, and
   * the reader is already logged into it. Slack and a ticket tracker are not here and
   * are not coming; this is the part of the same question a local runtime can answer.
   */
  pullRequest?: PullRequestState;
  /** Where it came from and when, because cached evidence must say it is cached. */
  source: string;
  fetchedAt: string;
}

export const REVIEW_DECISION = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes-requested',
  /** Open and nobody has decided. The state most refusals are actually about. */
  PENDING: 'pending',
} as const;

export type ReviewDecision = (typeof REVIEW_DECISION)[keyof typeof REVIEW_DECISION];

export interface PullRequestState {
  number: number;
  /** Absent when the forge reports none, which is not the same as pending. */
  decision?: ReviewDecision;
  /** True only when every required check has passed; absent when none ran. */
  checksPassing?: boolean;
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
interface PullRequestPayload {
  number?: unknown;
  reviewDecision?: unknown;
  statusCheckRollup?: { conclusion?: unknown }[];
}

const DECISIONS: Readonly<Record<string, ReviewDecision>> = {
  APPROVED: REVIEW_DECISION.APPROVED,
  CHANGES_REQUESTED: REVIEW_DECISION.CHANGES_REQUESTED,
  REVIEW_REQUIRED: REVIEW_DECISION.PENDING,
};

/**
 * Parsed rather than trusted, and every field is allowed to be absent.
 *
 * A forge that did not report a review decision means unknown, and printing "not
 * approved" about a repository whose reviews we could not read would be the same
 * reassurance-in-reverse that `readProtection` refuses to give about protection.
 */
export function readPullRequest(
  raw: string,
  source: string,
  fetchedAt: string,
): RepoEvidence | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not logged in, no PR, or `gh` printed something else. Absence, not an error.
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const payload = parsed as PullRequestPayload;
  if (typeof payload.number !== 'number') return null;

  const decision =
    typeof payload.reviewDecision === 'string'
      ? DECISIONS[payload.reviewDecision]
      : undefined;

  const checks = Array.isArray(payload.statusCheckRollup)
    ? payload.statusCheckRollup
    : undefined;
  /* Every check has to have concluded successfully. One still running is not passing,
     and calling it passing is how a gate waves through a build that later failed. */
  const checksPassing =
    checks === undefined || checks.length === 0
      ? undefined
      : checks.every((check) => check.conclusion === 'SUCCESS');

  return {
    pullRequest: {
      number: payload.number,
      ...(decision === undefined ? {} : { decision }),
      ...(checksPassing === undefined ? {} : { checksPassing }),
    },
    source,
    fetchedAt,
  };
}

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

  const pr = evidence.pullRequest;
  if (pr !== undefined) {
    /* Said as what the forge reports, not as a verdict. "Not approved" about a
       repository whose reviews we could not read is the one line here that would
       be worse than saying nothing. */
    const decision =
      pr.decision === undefined
        ? 'no review decision reported'
        : pr.decision === REVIEW_DECISION.APPROVED
          ? 'approved'
          : pr.decision === REVIEW_DECISION.CHANGES_REQUESTED
            ? 'changes requested'
            : 'open and not approved';
    lines.push(`pull request #${pr.number}: ${decision} (${evidence.source})`);
    if (pr.checksPassing !== undefined) {
      lines.push(pr.checksPassing ? 'checks: all passing' : 'checks: not all passing');
    }
  }
  return lines;
}
