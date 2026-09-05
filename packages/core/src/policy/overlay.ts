/**
 * A rule that is true for a while. An incident opens, deploys stop; the incident
 * closes, they start again — without anybody editing a policy file under pressure and
 * forgetting to put it back.
 *
 * A freeze that outlives its incident is worse than no freeze, because the next one
 * gets ignored. So an expiry is required, never defaulted, and the moment is always an
 * argument rather than a clock this module reads.
 */

export const OVERLAY_KIND = {
  /** Deploys and other external-state verbs stop for a named thing. */
  FREEZE: 'freeze',
  /** An incident is open. Rules can match on it without stopping anything themselves. */
  INCIDENT: 'incident',
} as const;

export type OverlayKind = (typeof OVERLAY_KIND)[keyof typeof OVERLAY_KIND];

export interface Overlay {
  id: string;
  kind: OverlayKind;
  /** What it is about: a service, a repository, an environment. */
  subject: string;
  /** Why, in the words the refusal will use. */
  reason: string;
  declaredAt: string;
  /** Required. An overlay with no end is a policy change wearing a costume. */
  validUntil: string;
  /** Where it came from: a person here, or an incident tool through the cloud. */
  source: string;
  /** Set when somebody ended it early. It stays in the record rather than vanishing. */
  liftedAt?: string;
}

export function validateOverlay(overlay: Partial<Overlay>): string[] {
  const problems: string[] = [];
  if (overlay.subject === undefined || overlay.subject.trim() === '') {
    problems.push('an overlay must name what it is about');
  }
  if (overlay.validUntil === undefined) {
    problems.push(
      'an overlay must say when it ends — one that never expires gets ignored',
    );
  } else if (Number.isNaN(Date.parse(overlay.validUntil))) {
    problems.push('validUntil must be an ISO 8601 timestamp');
  }
  if (overlay.reason === undefined || overlay.reason.trim() === '') {
    problems.push('an overlay must say why, or the refusal cannot explain itself');
  }
  return problems;
}

/** The moment is passed in, so a replay a month later gives the same answer. */
export function inForce(overlays: readonly Overlay[], moment: string): Overlay[] {
  return overlays.filter((overlay) => {
    if (overlay.liftedAt !== undefined && overlay.liftedAt <= moment) return false;
    return overlay.declaredAt <= moment && moment < overlay.validUntil;
  });
}

/**
 * The labels the engine matches on. `freeze:payments` lets a rule say "not while
 * payments is frozen" without the rule knowing anything about incidents.
 */
export function stateLabelsOf(overlays: readonly Overlay[], moment: string): string[] {
  return inForce(overlays, moment).map((overlay) => `${overlay.kind}:${overlay.subject}`);
}

/**
 * A content version of what was in force. Stamped on every verdict, so a freeze that
 * never reached a machine is visible afterwards rather than silently absent.
 */
export function stateVersionOf(overlays: readonly Overlay[], moment: string): string {
  const labels = stateLabelsOf(overlays, moment).sort();
  return labels.length === 0 ? 'none' : labels.join(',');
}

export function describeOverlay(overlay: Overlay, moment: string): string {
  const ends = new Date(overlay.validUntil);
  const minutes = Math.round((ends.getTime() - Date.parse(moment)) / 60_000);
  const remaining =
    minutes <= 0
      ? 'expired'
      : minutes < 60
        ? `${minutes} min left`
        : `${Math.round(minutes / 60)}h left`;
  return `${overlay.kind}:${overlay.subject} — ${overlay.reason} (${remaining}, ${overlay.source})`;
}

/** Minutes. Long enough for a real incident, short enough that forgetting is survivable. */
export const DEFAULT_FREEZE_MINUTES = 120;

export function freezeFor(
  subject: string,
  reason: string,
  minutes: number,
  now: string,
  source: string,
): Overlay {
  return {
    id: `ovl_${Date.parse(now).toString(36)}_${subject}`,
    kind: OVERLAY_KIND.FREEZE,
    subject,
    reason,
    declaredAt: now,
    validUntil: new Date(Date.parse(now) + minutes * 60_000).toISOString(),
    source,
  };
}
