import { minutesToMs } from '../domain/time';

/**
 * What this repository already says about itself, read through a CLI the reader is logged
 * into, so `why` can print a fact somebody else set beside a refusal.
 */
export interface RepoEvidence {
  /** Required approving reviews, when the forge reports one. */
  requiredReviews?: number;
  /** True when the branch is protected at all. */
  protected?: boolean;
  /** Present when CODEOWNERS covers the path in question. */
  codeowners?: string;
  /** The open pull request for this branch, since not approved is the commonest honest refusal. */
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
  return age < minutesToMs(EVIDENCE_TTL_MINUTES);
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
    // Not JSON, because gh prints an error here when the branch is unprotected.
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  // Every field is optional and checked where it is read.
  const payload = parsed as ProtectionPayload;
  const reviews = payload.required_pull_request_reviews?.required_approving_review_count;

  return {
    protected: true,
    ...(typeof reviews === 'number' ? { requiredReviews: reviews } : {}),
    source,
    fetchedAt: at,
  };
}

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
 * Parsed rather than trusted, every field allowed to be absent: an unreported review
 * decision is unknown, never not approved.
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
  // Every field is optional and checked where it is read.
  const payload = parsed as PullRequestPayload;
  if (typeof payload.number !== 'number') return null;

  const decision =
    typeof payload.reviewDecision === 'string'
      ? DECISIONS[payload.reviewDecision]
      : undefined;

  const checksPassing = checksPassingIn(payload.statusCheckRollup);
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

/**
 * Every check has to have concluded successfully, because one still running is how a
 * gate waves through a build that later failed. Absent when none ran.
 */
function checksPassingIn(
  rollup: PullRequestPayload['statusCheckRollup'],
): boolean | undefined {
  if (!Array.isArray(rollup) || rollup.length === 0) return undefined;
  return rollup.every((check) => check.conclusion === 'SUCCESS');
}

/** The CODEOWNERS entry covering a path, or null. Read from the file, never guessed. */
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

  const pullRequest = evidence.pullRequest;
  if (pullRequest !== undefined) {
    const decision = describeDecision(pullRequest.decision);
    lines.push(`pull request #${pullRequest.number}: ${decision} (${evidence.source})`);
    if (pullRequest.checksPassing !== undefined) {
      lines.push(
        pullRequest.checksPassing ? 'checks: all passing' : 'checks: not all passing',
      );
    }
  }
  return lines;
}

/**
 * What the forge reports, never a verdict: "not approved" about reviews that could not be
 * read would be worse than saying nothing.
 */
function describeDecision(decision: ReviewDecision | undefined): string {
  if (decision === undefined) return 'no review decision reported';
  if (decision === REVIEW_DECISION.APPROVED) return 'approved';
  if (decision === REVIEW_DECISION.CHANGES_REQUESTED) return 'changes requested';
  return 'open and not approved';
}
