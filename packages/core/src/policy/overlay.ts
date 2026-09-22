import { minutesToMs, msToMinutes } from '../domain/time';
import { describeSpan, IN_MINUTES_THEN_HOURS } from '../domain/duration-text';

/**
 * A rule that is true for a while, so an incident needs no edit to a policy file. The
 * expiry is required and the moment is always an argument, because a freeze that
 * outlives its incident is worse than no freeze.
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
      'an overlay must say when it ends, because one that never expires gets ignored',
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
  const minutes = msToMinutes(Date.parse(overlay.validUntil) - Date.parse(moment));
  const remaining =
    minutes <= 0
      ? 'expired'
      : `${describeSpan(minutesToMs(minutes), IN_MINUTES_THEN_HOURS)} left`;
  return `${overlay.kind}:${overlay.subject}: ${overlay.reason} (${remaining}, ${overlay.source})`;
}

/** Minutes. Long enough for a real incident, short enough that forgetting is survivable. */
export const DEFAULT_FREEZE_MINUTES = 120;

export interface FreezeInput {
  subject: string;
  reason: string;
  minutes: number;
  now: string;
  /** Who declared it: a person here, or the workspace. */
  source: string;
}

export function freezeFor(input: FreezeInput): Overlay {
  return {
    id: `ovl_${Date.parse(input.now).toString(36)}_${input.subject}`,
    kind: OVERLAY_KIND.FREEZE,
    subject: input.subject,
    reason: input.reason,
    declaredAt: input.now,
    validUntil: new Date(
      Date.parse(input.now) + minutesToMs(input.minutes),
    ).toISOString(),
    source: input.source,
  };
}
