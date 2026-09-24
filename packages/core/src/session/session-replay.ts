/**
 * One session told in order, from what the seams recorded: every action and its verdict,
 * the breaker trip and who lifted it, the holds still waiting, and the milestones kept.
 * Built from records alone, so it can be read long after every process involved is gone.
 */
import { DECISION_EFFECT, type DecisionEffect } from '../constants/decision.constants';
import { ENFORCEMENT_MODE } from '../constants/enforcement.constants';
import type { MemnoxEvent } from '../event/event';
import { didFail } from '../event/outcome';
import type { PendingApproval } from '../gate/pending';
import type { Milestone } from '../recovery/milestone';
import type { SessionPause } from './pause';

export const REPLAY_STEP = {
  ACTION: 'action',
  TRIP: 'breaker-trip',
  RESUME: 'resumed',
  HOLD: 'hold',
  MILESTONE: 'milestone',
} as const;

export type ReplayStepKind = (typeof REPLAY_STEP)[keyof typeof REPLAY_STEP];

/** How the session ended, which decides what the lead up is a lead up to. */
export const REPLAY_END = {
  /** The breaker paused it. */
  TRIPPED: 'tripped',
  /** Its last action failed, or a rule in force refused it. */
  FAILED: 'failed',
  /** Something went wrong and the session carried on past it. */
  RECOVERED: 'recovered',
  /** Nothing went wrong that the record can see. */
  CLEAN: 'clean',
} as const;

export type ReplayEnd = (typeof REPLAY_END)[keyof typeof REPLAY_END];

/** Actions shown as the lead up to a failure or a trip, the failing one included. */
export const LEAD_UP_STEPS = 5;

export interface ReplayStep {
  kind: ReplayStepKind;
  at: string;
  /** What happened, in one line a person reads down a column. */
  summary: string;
  /** True for the actions right before the failure or the trip. */
  leadUp?: boolean;
  /** The ledger row, for an action, so `memnox trace` can open it. */
  eventId?: string;
  surface?: string;
  operation?: string;
  target?: string;
  effect?: DecisionEffect;
  /** What enforce would have said while the session was only observed. */
  wouldBe?: DecisionEffect;
  exitCode?: number;
  failed?: boolean;
  reason?: string;
  rule?: string;
  /** Who released a held call, where somebody did. */
  answeredBy?: string;
  milestoneId?: string;
}

export interface SessionReplay {
  sessionId: string;
  agent?: string;
  startedAt?: string;
  endedAt?: string;
  end: ReplayEnd;
  /** Why it ended the way it did, where the record says. */
  endReason?: string;
  steps: ReplayStep[];
}

export interface ReplayInput {
  sessionId: string;
  /** Chronological, as the ledger returns them. */
  events: readonly MemnoxEvent[];
  pause?: SessionPause | null;
  pending?: readonly PendingApproval[];
  milestones?: readonly Milestone[];
}

function actionSummary(event: MemnoxEvent): string {
  const what =
    event.target === undefined ? event.operation : `${event.operation} ${event.target}`;
  const observed =
    event.mode === ENFORCEMENT_MODE.OBSERVE && event.shadowEffect !== undefined
      ? ` (would be ${event.shadowEffect})`
      : '';
  const exit =
    event.exitCode === undefined || event.exitCode === 0
      ? ''
      : `, exit ${event.exitCode}`;
  const answered =
    event.authorizedBy === undefined ? '' : `, allowed by ${event.authorizedBy}`;
  return `${event.effect}${observed}  ${what}${exit}${answered}`;
}

function actionStep(event: MemnoxEvent): ReplayStep {
  return {
    kind: REPLAY_STEP.ACTION,
    at: event.at,
    summary: actionSummary(event),
    eventId: event.id,
    surface: event.surface,
    operation: event.operation,
    effect: event.effect,
    failed: didFail(event),
    reason: event.reason,
    ...(event.target === undefined ? {} : { target: event.target }),
    ...(event.shadowEffect === undefined ? {} : { wouldBe: event.shadowEffect }),
    ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
    ...(event.rule === undefined ? {} : { rule: event.rule.name }),
    ...(event.authorizedBy === undefined ? {} : { answeredBy: event.authorizedBy }),
  };
}

function pauseSteps(pause: SessionPause): ReplayStep[] {
  const trip: ReplayStep = {
    kind: REPLAY_STEP.TRIP,
    at: pause.pausedAt,
    summary: `breaker tripped on ${pause.signal}: ${pause.reason} (${pause.reached} of ${pause.ceiling})`,
    reason: pause.reason,
    ...(pause.lastAction === undefined ? {} : { operation: pause.lastAction }),
  };
  if (pause.resumedAt === undefined) return [trip];
  const by = pause.resumedBy ?? 'somebody';
  const resume: ReplayStep = {
    kind: REPLAY_STEP.RESUME,
    at: pause.resumedAt,
    summary: `resumed by ${by}`,
    answeredBy: by,
  };
  return [trip, resume];
}

function holdStep(pending: PendingApproval): ReplayStep {
  const { request } = pending;
  const what =
    request.target === undefined
      ? request.operation
      : `${request.operation} ${request.target}`;
  const state =
    pending.answer === undefined
      ? 'waiting for an answer'
      : `answered ${pending.answer} by ${pending.answeredBy ?? 'somebody'}`;
  return {
    kind: REPLAY_STEP.HOLD,
    at: pending.askedAt,
    summary: `held ${what}, ${state}`,
    operation: request.operation,
    reason: request.reason,
    ...(request.target === undefined ? {} : { target: request.target }),
    ...(pending.answeredBy === undefined ? {} : { answeredBy: pending.answeredBy }),
  };
}

function milestoneStep(milestone: Milestone): ReplayStep {
  const what = milestone.note ?? milestone.reason;
  return {
    kind: REPLAY_STEP.MILESTONE,
    at: milestone.takenAt,
    summary: `milestone ${milestone.id} kept, ${what}, ${milestone.files} file(s)`,
    milestoneId: milestone.id,
  };
}

/** An action that went wrong: its command failed, or a rule in force refused it. */
function wentWrong(step: ReplayStep): boolean {
  return (
    step.kind === REPLAY_STEP.ACTION &&
    (step.failed === true || step.effect === DECISION_EFFECT.DENY)
  );
}

/** Where the trouble is: the trip if there was one, else the last action that went wrong. */
function troubleAt(
  steps: readonly ReplayStep[],
): { index: number; end: ReplayEnd } | null {
  const trip = steps.findIndex((step) => step.kind === REPLAY_STEP.TRIP);
  if (trip !== -1) return { index: trip, end: REPLAY_END.TRIPPED };
  const actions = steps.filter((step) => step.kind === REPLAY_STEP.ACTION);
  const last = actions[actions.length - 1];
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step === undefined || !wentWrong(step)) continue;
    return { index, end: step === last ? REPLAY_END.FAILED : REPLAY_END.RECOVERED };
  }
  return null;
}

/** Marks the actions leading up to the trouble, the failing one included. */
function markLeadUp(steps: ReplayStep[], index: number): void {
  let marked = 0;
  for (let at = index; at >= 0 && marked < LEAD_UP_STEPS; at -= 1) {
    const step = steps[at];
    if (step === undefined || step.kind !== REPLAY_STEP.ACTION) continue;
    step.leadUp = true;
    marked += 1;
  }
}

/** Every record about one session, merged into the order it happened in. */
export function buildReplay(input: ReplayInput): SessionReplay {
  const events = input.events.filter((event) => event.sessionId === input.sessionId);
  const steps: ReplayStep[] = [
    ...events.map(actionStep),
    ...(input.pause === undefined || input.pause === null ? [] : pauseSteps(input.pause)),
    ...(input.pending ?? [])
      .filter((pending) => pending.request.sessionId === input.sessionId)
      .map(holdStep),
    ...(input.milestones ?? [])
      .filter((milestone) => milestone.sessionId === input.sessionId)
      .map(milestoneStep),
  ];
  // Stable, so two records at one instant keep the order they were written in.
  steps.sort((a, b) => a.at.localeCompare(b.at));
  const trouble = troubleAt(steps);
  if (trouble !== null) markLeadUp(steps, trouble.index);
  const troubleStep = trouble === null ? undefined : steps[trouble.index];
  const agent =
    events[0]?.agent ??
    input.milestones?.find((milestone) => milestone.agent !== undefined)?.agent;
  const first = steps[0];
  const last = steps[steps.length - 1];
  return {
    sessionId: input.sessionId,
    ...(agent === undefined ? {} : { agent }),
    ...(first === undefined ? {} : { startedAt: first.at }),
    ...(last === undefined ? {} : { endedAt: last.at }),
    end: trouble === null ? REPLAY_END.CLEAN : trouble.end,
    ...(troubleStep === undefined ? {} : { endReason: troubleStep.summary }),
    steps,
  };
}
