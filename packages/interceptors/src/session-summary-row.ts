/**
 * What a hooked session did, kept as one row when it ends, since a session that no
 * `memnox run` started has nobody at its end to print a summary to.
 */
import {
  ACTOR_TYPE,
  DECISION_EFFECT,
  describeSummary,
  ENFORCEMENT_MODE,
  EVENT_SCHEMA_VERSION,
  EVENT_SURFACE,
  LEDGER_SESSION_LIMIT,
  newEventId,
  openLedger,
  summarizeSession,
  TOOL_CLASS,
} from '@memnox/core';

/** Filed with the config rows, so no count of agent work ever includes it. */
export const SESSION_SUMMARY_OPERATION = 'session.summary';

/** Best effort: a session ending is never held up by its own record. */
export async function keepSessionSummary(
  home: string,
  sessionId: string,
  now: Date,
): Promise<void> {
  const ledger = openLedger(home);
  if (ledger === null) return;
  try {
    const summary = summarizeSession(
      await ledger.query({ sessionId, limit: LEDGER_SESSION_LIMIT }),
    );
    if (summary === null) return;
    await ledger.append({
      id: newEventId(),
      schemaVersion: EVENT_SCHEMA_VERSION,
      at: now.toISOString(),
      sessionId,
      agent: summary.agent,
      actorType: ACTOR_TYPE.AUTOMATION,
      surface: EVENT_SURFACE.CONFIG,
      operation: SESSION_SUMMARY_OPERATION,
      class: TOOL_CLASS.READ,
      effect: DECISION_EFFECT.ALLOW,
      mode: ENFORCEMENT_MODE.ENFORCE,
      reason: describeSummary(summary),
    });
  } catch {
    // Nothing to do about a lost summary, and nothing worth failing the hook for.
  } finally {
    ledger.close();
  }
}
