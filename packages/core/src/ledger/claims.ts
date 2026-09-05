import type { MemnoxEvent } from '../event/event';
import { EXECUTION } from '../event/event';

/**
 * What an agent said it did, checked against what the ledger recorded. A fixed pattern
 * table and a lookup — no model reads the transcript, because a model deciding whether
 * somebody lied is exactly the claim this product must not make on evidence it invented.
 */

export const CLAIM_KIND = {
  TESTS_PASSED: 'tests-passed',
  DEPLOYED: 'deployed',
  COMMITTED: 'committed',
  PUSHED: 'pushed',
  CREATED: 'created',
  MERGED: 'merged',
} as const;

export type ClaimKind = (typeof CLAIM_KIND)[keyof typeof CLAIM_KIND];

interface Pattern {
  kind: ClaimKind;
  pattern: RegExp;
  /** Operations that would prove it. Matched as a prefix on the event's operation. */
  provenBy: readonly string[];
}

const PATTERNS: readonly Pattern[] = [
  {
    kind: CLAIM_KIND.TESTS_PASSED,
    pattern:
      /\b(tests?|suite|specs?)\s+(pass|passed|passing|succeeded|(is|are)\s+green)\b/i,
    provenBy: ['shell.execute', 'npm', 'pnpm', 'yarn', 'test'],
  },
  {
    kind: CLAIM_KIND.TESTS_PASSED,
    pattern: /\ball (the )?tests? (now )?pass\b/i,
    provenBy: ['shell.execute', 'npm', 'pnpm', 'yarn', 'test'],
  },
  {
    kind: CLAIM_KIND.DEPLOYED,
    pattern: /\b(deployed|shipped|rolled out|released)\b/i,
    provenBy: ['deploy.'],
  },
  {
    kind: CLAIM_KIND.COMMITTED,
    pattern: /\b(committed|made a commit)\b/i,
    provenBy: ['git.commit'],
  },
  {
    kind: CLAIM_KIND.PUSHED,
    pattern: /\b(pushed|push(ed)? (it |the branch )?up)\b/i,
    provenBy: ['git.push'],
  },
  {
    kind: CLAIM_KIND.MERGED,
    pattern: /\b(merged|merge(d)? the (pr|pull request))\b/i,
    provenBy: ['git.merge', 'github.merge'],
  },
  {
    kind: CLAIM_KIND.CREATED,
    pattern: /\b(created|opened) (a |the )?(pr|pull request|issue|file|branch)\b/i,
    provenBy: ['github.create', 'git.branch', 'file.write', 'filesystem.write'],
  },
];

export interface Claim {
  kind: ClaimKind;
  /** The sentence that carried it, so a person can judge the match themselves. */
  said: string;
}

export function claimsIn(text: string): Claim[] {
  const found: Claim[] = [];
  for (const line of text.split('\n')) {
    for (const entry of PATTERNS) {
      if (!entry.pattern.test(line)) continue;
      if (found.some((claim) => claim.kind === entry.kind)) continue;
      found.push({ kind: entry.kind, said: line.trim() });
    }
  }
  return found;
}

export const CLAIM_VERDICT = {
  /** The ledger holds something that would produce this claim. */
  SUPPORTED: 'supported',
  /** Something ran, and it failed. The claim contradicts the record. */
  CONTRADICTED: 'contradicted',
  /** Nothing in the ledger could have produced it. Not proof of a lie. */
  UNSUPPORTED: 'unsupported',
} as const;

export type ClaimVerdict = (typeof CLAIM_VERDICT)[keyof typeof CLAIM_VERDICT];

export interface CheckedClaim extends Claim {
  verdict: ClaimVerdict;
  /** Event ids behind the verdict. Empty for unsupported, which is the point. */
  evidence: string[];
  because: string;
}

function provingEvents(kind: ClaimKind, events: readonly MemnoxEvent[]): MemnoxEvent[] {
  const patterns = PATTERNS.filter((entry) => entry.kind === kind);
  return events.filter((event) =>
    patterns.some((entry) =>
      entry.provenBy.some((prefix) => event.operation.startsWith(prefix)),
    ),
  );
}

/**
 * Reported, never refereed. "Unsupported" means the ledger holds nothing that would
 * have produced the claim — which is often that the work happened somewhere this
 * machine cannot see, and saying otherwise would be an accusation built on a gap.
 */
export function checkClaims(
  text: string,
  events: readonly MemnoxEvent[],
): CheckedClaim[] {
  return claimsIn(text).map((claim) => {
    const candidates = provingEvents(claim.kind, events);
    if (candidates.length === 0) {
      return {
        ...claim,
        verdict: CLAIM_VERDICT.UNSUPPORTED,
        evidence: [],
        because: 'nothing here recorded an action that would have done it',
      };
    }

    const failed = candidates.filter(
      (event) =>
        event.execution === EXECUTION.FAILED ||
        (event.exitCode !== undefined && event.exitCode !== 0),
    );
    if (failed.length > 0 && failed.length === candidates.length) {
      return {
        ...claim,
        verdict: CLAIM_VERDICT.CONTRADICTED,
        evidence: failed.map((event) => event.id),
        because: `it ran and did not succeed (exit ${failed[0]?.exitCode ?? 'non-zero'})`,
      };
    }

    return {
      ...claim,
      verdict: CLAIM_VERDICT.SUPPORTED,
      evidence: candidates.map((event) => event.id),
      because: `${candidates.length} matching action(s) in the record`,
    };
  });
}
