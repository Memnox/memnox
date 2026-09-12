import { DECISION_EFFECT } from '../constants/decision.constants';
import { TOOL_CLASS, type ToolClass } from '../discovery/classify';
import type { MemnoxEvent } from '../event/event';

/**
 * What could safely be handed over next.
 *
 * The primary question this product answers is not "what did my agent do" but "what
 * can I safely let it do next", and the only honest source for that is what a person
 * has already approved. Twenty-three identical yeses are a decision somebody has made
 * over and over; asking a twenty-fourth time is the tool wasting their attention.
 *
 * Nothing here is a score. Every number on the screen is a count of something that
 * actually happened, because a confidence percentage is a thing nobody can check and
 * this is a screen people are being asked to act on.
 */

export const AUTONOMY = {
  /** Watched, nothing enforced. Where every install starts. */
  OBSERVE: 'observe',
  /** Asked about the things that change something. */
  ASSIST: 'assist',
  /** Routine work runs; anything outward or destructive is held. */
  SUPERVISED: 'supervised',
  /** Runs on its own, inside a boundary somebody wrote. */
  AUTONOMOUS: 'autonomous',
  /** Runs on its own, and the boundary has stopped catching anything. */
  TRUSTED: 'trusted',
} as const;

export type AutonomyLevel = (typeof AUTONOMY)[keyof typeof AUTONOMY];

export const AUTONOMY_ORDER: readonly AutonomyLevel[] = [
  AUTONOMY.OBSERVE,
  AUTONOMY.ASSIST,
  AUTONOMY.SUPERVISED,
  AUTONOMY.AUTONOMOUS,
  AUTONOMY.TRUSTED,
];

/** Identical yeses before the same question stops being worth asking. */
export const PROMOTION_THRESHOLD = 5;

/**
 * Actions in the window before the top two rungs can be claimed at all.
 *
 * Without a floor, a machine that ran three commands and was asked about none reads as
 * `trusted` on its first afternoon — the top of a ladder whose whole point is that it
 * is climbed as evidence accumulates. An absence of interruptions is not evidence of
 * trustworthiness when there was nothing much to interrupt, and a screen that says
 * otherwise is the one thing that would make the rest of this untrustworthy.
 */
export const MINIMUM_EVIDENCE = 50;

export interface Delegation {
  action: string;
  /** Times a person said yes to this exact thing. */
  approvals: number;
  /** Times a person said no. One is enough to stop a recommendation. */
  denials: number;
  lastAt: string;
  class: ToolClass;
  /** What this could become, and never more than the class allows. */
  recommendation: AutonomyLevel;
  /** Why, in the words the screen prints. */
  because: string;
}

/**
 * A destructive action never becomes autonomous on the strength of a habit.
 *
 * The point of the ladder is that it goes up as evidence accumulates, and the point of
 * this ceiling is that some things stay a decision however routine they became. An
 * agent that has deleted the right thing forty times is an agent that will delete the
 * wrong thing on the forty-first.
 */
const CEILING: Readonly<Record<string, AutonomyLevel>> = {
  [TOOL_CLASS.READ]: AUTONOMY.TRUSTED,
  [TOOL_CLASS.WRITE]: AUTONOMY.AUTONOMOUS,
  [TOOL_CLASS.COMMUNICATION]: AUTONOMY.SUPERVISED,
  [TOOL_CLASS.DESTRUCTIVE]: AUTONOMY.SUPERVISED,
  [TOOL_CLASS.UNKNOWN]: AUTONOMY.SUPERVISED,
};

function ceilingFor(toolClass: ToolClass): AutonomyLevel {
  return CEILING[toolClass] ?? AUTONOMY.SUPERVISED;
}

interface Tally {
  approvals: number;
  denials: number;
  lastAt: string;
  class: ToolClass;
}

/**
 * What a person has decided, per action.
 *
 * An `ask` that carries an authorizer is a yes somebody typed. A `deny` is a no. An
 * `allow` is a rule already deciding and is not evidence about delegation at all —
 * counting it would recommend promoting things that were never being asked about.
 */
export function delegations(
  events: readonly MemnoxEvent[],
  threshold = PROMOTION_THRESHOLD,
): Delegation[] {
  const tallies = new Map<string, Tally>();
  for (const event of events) {
    const asked = event.effect === DECISION_EFFECT.ASK;
    const denied = event.effect === DECISION_EFFECT.DENY;
    if (!asked && !denied) continue;

    const tally = tallies.get(event.operation) ?? {
      approvals: 0,
      denials: 0,
      lastAt: event.at,
      class: event.class,
    };
    if (asked && event.authorizedBy !== undefined) tally.approvals += 1;
    if (denied) tally.denials += 1;
    if (event.at > tally.lastAt) tally.lastAt = event.at;
    tallies.set(event.operation, tally);
  }

  const found: Delegation[] = [];
  for (const [action, tally] of tallies) {
    found.push({
      action,
      approvals: tally.approvals,
      denials: tally.denials,
      lastAt: tally.lastAt,
      class: tally.class,
      ...recommend(tally, threshold),
    });
  }
  return found.sort(
    (a, b) => b.approvals - a.approvals || a.action.localeCompare(b.action),
  );
}

function recommend(
  tally: Tally,
  threshold: number,
): { recommendation: AutonomyLevel; because: string } {
  if (tally.denials > 0) {
    /* One no is enough. A thing somebody has refused is a thing they want to be asked
       about, and the count of yeses before it does not overrule that. */
    return {
      recommendation: AUTONOMY.ASSIST,
      because: `refused ${tally.denials} time(s); keep asking`,
    };
  }
  if (tally.approvals < threshold) {
    return {
      recommendation: AUTONOMY.ASSIST,
      because: `approved ${tally.approvals} time(s), fewer than the ${threshold} that would make this a habit`,
    };
  }

  const ceiling = ceilingFor(tally.class);
  const because =
    ceiling === AUTONOMY.SUPERVISED
      ? `approved ${tally.approvals} times, and stays supervised because it is ${tally.class}`
      : `approved ${tally.approvals} times with no refusal`;
  return { recommendation: ceiling, because };
}

/** The ones worth putting on a screen: a habit, and nothing arguing against it. */
export function promotable(
  found: readonly Delegation[],
  threshold = PROMOTION_THRESHOLD,
): Delegation[] {
  return found.filter(
    (each) =>
      each.denials === 0 &&
      each.approvals >= threshold &&
      each.recommendation !== AUTONOMY.ASSIST,
  );
}

/**
 * How often somebody is being interrupted, as a count rather than as hours.
 *
 * The temptation is to price it — "six hours a week you could get back" — and that
 * number would be invented. Interruptions are a thing that actually happened and can
 * be checked against the ledger, so that is what gets printed.
 */
export function interruptions(
  events: readonly MemnoxEvent[],
  since: string,
): { total: number; byAction: { action: string; count: number }[] } {
  const counts = new Map<string, number>();
  let total = 0;
  for (const event of events) {
    if (event.effect !== DECISION_EFFECT.ASK) continue;
    if (event.at < since) continue;
    total += 1;
    counts.set(event.operation, (counts.get(event.operation) ?? 0) + 1);
  }
  return {
    total,
    byAction: [...counts]
      .map(([action, count]) => ({ action, count }))
      .sort((a, b) => b.count - a.count),
  };
}

/**
 * Where this machine sits on the ladder, from what is actually configured and seen.
 *
 * Read off facts rather than declared: an install that says it is `autonomous` while
 * asking about everything is telling somebody a story about themselves.
 */
export function standingOf(input: {
  enforcing: boolean;
  rules: number;
  asksInWindow: number;
  actionsInWindow: number;
}): AutonomyLevel {
  if (!input.enforcing || input.rules === 0) return AUTONOMY.OBSERVE;
  if (input.actionsInWindow === 0) return AUTONOMY.ASSIST;
  const askRate = input.asksInWindow / input.actionsInWindow;
  if (askRate > 0.2) return AUTONOMY.ASSIST;
  if (askRate > 0.02) return AUTONOMY.SUPERVISED;

  /* Quiet is not the same as proved. Until there is enough work behind it, a clean
     record earns supervised and no more: the rungs above are claims about a boundary
     that has been tested, and three commands have not tested one. */
  if (input.actionsInWindow < MINIMUM_EVIDENCE) return AUTONOMY.SUPERVISED;

  if (input.asksInWindow > 0) return AUTONOMY.AUTONOMOUS;
  return AUTONOMY.TRUSTED;
}

export function describeLevel(level: AutonomyLevel): string {
  const words: Record<AutonomyLevel, string> = {
    [AUTONOMY.OBSERVE]: 'watching, enforcing nothing',
    [AUTONOMY.ASSIST]: 'asking about most things that change something',
    [AUTONOMY.SUPERVISED]: 'routine work runs, the rest is held',
    [AUTONOMY.AUTONOMOUS]: 'running inside a boundary you wrote',
    [AUTONOMY.TRUSTED]: 'running, and the boundary has caught nothing',
  };
  return words[level];
}

/**
 * Whether one action may stop being asked about, and the sentence for why not.
 *
 * The same three tests the recommendation already applies, said once so a screen and
 * the command under it cannot disagree. Until this existed the screen printed
 * `memnox protect --allow <action>` under every promotable row, including the ones
 * whose own reason said they stay supervised, which is a screen arguing with itself.
 *
 * A refusal is a sentence rather than a boolean, because "skipped" with no reason is
 * how somebody concludes the tool is broken and hand-writes the rule anyway.
 */
export type HandOverVerdict =
  | { action: string; ready: true; delegation: Delegation }
  | { action: string; ready: false; because: string };

export function handOverVerdict(
  action: string,
  found: readonly Delegation[],
  threshold = PROMOTION_THRESHOLD,
): HandOverVerdict {
  const seen = found.find((each) => each.action === action);
  if (seen === undefined) {
    return {
      action,
      ready: false,
      because: 'nothing has been held for it, so there is no yes to stop asking for',
    };
  }
  /* One no outranks any number of yeses, exactly as the recommendation does. */
  if (seen.denials > 0) {
    return {
      action,
      ready: false,
      because: `somebody refused it ${seen.denials} time(s), so it stays a question`,
    };
  }
  if (seen.approvals < threshold) {
    return {
      action,
      ready: false,
      because: `approved ${seen.approvals} time(s), fewer than the ${threshold} that make it a habit`,
    };
  }
  /* The ceiling, not a preference: destructive and outward things stay decisions
     however routine they became. */
  if (seen.recommendation === AUTONOMY.SUPERVISED) {
    return {
      action,
      ready: false,
      because: `it is ${seen.class}, which stays supervised however routine it became`,
    };
  }
  return { action, ready: true, delegation: seen };
}

/** The rows on a screen that `--allow` would actually take, so neither names the other wrongly. */
export function handable(each: Delegation): boolean {
  return (
    each.denials === 0 &&
    each.approvals >= PROMOTION_THRESHOLD &&
    each.recommendation !== AUTONOMY.ASSIST &&
    each.recommendation !== AUTONOMY.SUPERVISED
  );
}
