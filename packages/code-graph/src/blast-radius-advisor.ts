import type {
  ActionAdvisor,
  ActionRequest,
  Advisory,
  AdvisoryContext,
} from '@memnox/core';
import { DECISION_EFFECT } from '@memnox/core';
import { matchesPattern } from '@memnox/policy-engine';
import { computeBlastRadius } from './blast-radius';
import type { CodeGraph } from './code-graph';
import { WIDE_REACH_FILE_THRESHOLD } from './code-graph.constants';

export const BLAST_RADIUS_ADVISOR = 'blast-radius';

export const BLAST_RADIUS_SIGNAL = {
  REACHES_PROTECTED_PATH: 'blast-radius-reaches-protected-path',
  WIDE_REACH: 'blast-radius-wide-reach',
} as const;

/** Actions that modify a source file, and so have a blast radius worth computing. */
export const CODE_MUTATING_ACTIONS: readonly string[] = [
  'code.modify',
  'code.delete',
  'file.write',
  'file.delete',
];

export interface BlastRadiusAdvisorOptions {
  /** Path patterns whose reachability requires a human, e.g. ["payment/*", "auth/*"]. */
  protectedPaths: readonly string[];
  approvers: readonly string[];
  /** Reached-file count above which a signal-only wide-reach advisory is raised. */
  wideReachThreshold?: number;
}

const MAX_LISTED_PATHS = 5;

function summarize(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_LISTED_PATHS).join(', ');
  const remaining = paths.length - MAX_LISTED_PATHS;
  return remaining > 0 ? `${shown} (+${remaining} more)` : shown;
}

/**
 * Escalates a code change by what it can reach, not just by the path it names:
 * editing a shared helper that `payment/` imports is a payment change.
 *
 * Escalation-only, and silent when it cannot be certain — an unresolvable target
 * or an absent graph yields no advisory rather than a guess.
 */
export class BlastRadiusAdvisor implements ActionAdvisor {
  readonly name = BLAST_RADIUS_ADVISOR;

  private readonly protectedPaths: readonly string[];
  private readonly approvers: string[];
  private readonly wideReachThreshold: number;

  constructor(
    private readonly graph: CodeGraph | null,
    options: BlastRadiusAdvisorOptions,
  ) {
    this.protectedPaths = options.protectedPaths;
    this.approvers = [...options.approvers];
    this.wideReachThreshold = options.wideReachThreshold ?? WIDE_REACH_FILE_THRESHOLD;
  }

  async advise(request: ActionRequest, _context: AdvisoryContext): Promise<Advisory[]> {
    if (!this.graph || !request.target) return [];
    if (!CODE_MUTATING_ACTIONS.includes(request.action)) return [];

    const radius = computeBlastRadius(this.graph, request.target);
    if (!radius.resolvedPath) return [];

    const advisories: Advisory[] = [];
    const protectedHits = this.protectedHits(radius.reached);

    if (protectedHits.length > 0) {
      advisories.push({
        source: this.name,
        escalateTo: DECISION_EFFECT.REQUIRE_APPROVAL,
        reason: `changing ${radius.resolvedPath} transitively reaches protected code: ${summarize(protectedHits)}`,
        approvers: this.approvers,
        signals: [BLAST_RADIUS_SIGNAL.REACHES_PROTECTED_PATH],
      });
    }

    if (radius.reached.length >= this.wideReachThreshold) {
      advisories.push({
        source: this.name,
        reason: `changing ${radius.resolvedPath} reaches ${radius.reached.length}${radius.truncated ? '+' : ''} files across ${radius.depth} import hops`,
        signals: [BLAST_RADIUS_SIGNAL.WIDE_REACH],
      });
    }

    return advisories;
  }

  private protectedHits(reached: readonly string[]): string[] {
    return reached.filter((path) =>
      this.protectedPaths.some((pattern) => matchesPattern(pattern, path)),
    );
  }
}
