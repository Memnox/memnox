import type {
  ActionAdvisor,
  ActionRequest,
  Advisory,
  AdvisoryContext,
  Logger,
  SessionTaintStore,
} from '@memnox/core';
import {
  CLEAN_SESSION_TAINT,
  CLEAN_TAINT,
  DECISION_EFFECT,
  mergeTaint,
  SILENT_LOGGER,
  TAINT_NO_OVERRIDE_ACTIONS,
} from '@memnox/core';
import { matchesAny } from '@memnox/policy-engine';

export const TAINT_ADVISOR = 'taint-guard';

/** Actions gated when untrusted content influenced the agent's context. */
export const TAINT_PRIVILEGED_ACTION_PATTERNS: readonly string[] = [
  'file.write',
  'shell.execute',
  'deploy.*',
  'data.export',
  'database.*',
  'mcp.*',
  '*.delete',
];

const SIGNAL_PREFIX = 'taint:';

/**
 * Prompt-injection defense: blocking is structural — if any untrusted source
 * entered the session's context, privileged actions need a human no matter how
 * benign they look. Taint is monotonic per session: once reported, it sticks.
 */
export class TaintAdvisor implements ActionAdvisor {
  readonly name = TAINT_ADVISOR;

  constructor(
    private readonly sessions: SessionTaintStore,
    private readonly logger: Logger = SILENT_LOGGER,
  ) {}

  async advise(request: ActionRequest, _context: AdvisoryContext): Promise<Advisory[]> {
    // Provenance is the fail-closed exception to "advisor failure = no escalation"
    // (CLAUDE.md): an unreadable store reports taint rather than silently allowing.
    const state = request.sessionId
      ? await this.sessions.read(request.sessionId)
      : CLEAN_SESSION_TAINT;
    const merged = mergeTaint(request.taint ?? CLEAN_TAINT, state.taint);
    await this.remember(request);

    if (!merged.tainted) return [];
    if (!matchesAny([...TAINT_PRIVILEGED_ACTION_PATTERNS], request.action)) return [];

    const signals = merged.sources.map(
      (source) => `${SIGNAL_PREFIX}${source.sourceType}`,
    );
    const sourceSummary = merged.sources
      .slice(0, 3)
      .map((source) => source.sourceType)
      .join(', ');

    if (matchesAny([...TAINT_NO_OVERRIDE_ACTIONS], request.action)) {
      return [
        {
          source: this.name,
          escalateTo: DECISION_EFFECT.BLOCK,
          nonOverridable: true,
          reason: `"${request.action}" is irreversible and the context contains ${merged.sources.length} untrusted source(s) (${sourceSummary}) — no approval can unblock it`,
          signals,
        },
      ];
    }

    return [
      {
        source: this.name,
        escalateTo: DECISION_EFFECT.REQUIRE_APPROVAL,
        reason: `agent context contains ${merged.sources.length} untrusted source(s) (${sourceSummary}) — privileged action needs a human`,
        signals,
      },
    ];
  }

  /** Persisting here is what makes taint stick: later actions in the session need no re-reporting. */
  private async remember(request: ActionRequest): Promise<void> {
    const taint = request.taint;
    if (!request.sessionId || taint === undefined || !taint.tainted) return;
    try {
      await this.sessions.merge(request.sessionId, taint);
    } catch (err) {
      this.logger.error(
        `session taint not persisted for ${request.sessionId} — later actions may not inherit it: ${String(err)}`,
      );
    }
  }
}
