import type {
  ActionAdvisor,
  ActionRequest,
  Advisory,
  AdvisoryContext,
} from '@memnox/core';
import { DECISION_EFFECT } from '@memnox/core';
import { isBlocking } from './finding';
import { scanContent } from './scanner';

export const CONTENT_SHIELD_ADVISOR = 'content-shield';
/** Actions whose metadata.content is scanned before they execute. */
export const CONTENT_SCANNED_ACTIONS: readonly string[] = ['file.write'];
/** Metadata key the interception layer uses to hand over the proposed content. */
export const CONTENT_METADATA_KEY = 'content';

/**
 * Scans the content an agent is about to write for secrets and PII.
 * Blocking findings (critical/high) block the write; medium findings are
 * signal-only. Pure regex rules — no network, deterministic.
 */
export class ContentShieldAdvisor implements ActionAdvisor {
  readonly name = CONTENT_SHIELD_ADVISOR;

  async advise(request: ActionRequest, _context: AdvisoryContext): Promise<Advisory[]> {
    if (!CONTENT_SCANNED_ACTIONS.includes(request.action)) return [];
    const metadata = request.metadata;
    const content = metadata === undefined ? undefined : metadata[CONTENT_METADATA_KEY];
    if (typeof content !== 'string' || content.length === 0) return [];

    const findings = scanContent(request.target ?? '', content);
    if (findings.length === 0) return [];

    const blocking = findings.filter(isBlocking);
    const worst = blocking[0] ?? findings[0];
    if (!worst) return [];
    return [
      {
        source: this.name,
        escalateTo: blocking.length > 0 ? DECISION_EFFECT.BLOCK : undefined,
        reason: `${worst.message} at line ${worst.line} (${worst.excerpt}). ${worst.fix}`,
        signals: findings.map((finding) => `shield:${finding.rule}`),
      },
    ];
  }
}
