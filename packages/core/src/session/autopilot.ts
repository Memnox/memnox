import { DECISION_EFFECT, type DecisionEffect } from '../constants/decision.constants';
import { TOOL_CLASS, type ToolClass } from '../discovery/classify';
import { verbAction, verbTableFor } from '../verbs/index';
import type { Policy } from '../policy/policy';
import {
  describeReversibility,
  mayBeAutomatic,
  reversibilityOf,
  type Reversibility,
} from '../domain/reversibility';

/**
 * "Run this agent on its own", turned into a boundary somebody can read.
 *
 * The point is that a person should not have to understand IAM, MCP permissions, file
 * modes and OAuth scopes to answer one question: can I leave this running? So the
 * boundary is rendered as three bands in plain words, and every line in it is the
 * verdict the rules would actually reach — not a description of them.
 *
 * That last part is the whole discipline here. A screen that lists what the policy
 * *intends* is marketing; this one asks the engine, action by action, so what it shows
 * is what will happen.
 */

export const BAND = {
  /** Runs without asking. */
  AUTOMATIC: 'automatic',
  /** Held for a person. */
  NEEDS_APPROVAL: 'needs-approval',
  NEVER: 'never',
} as const;

export type Band = (typeof BAND)[keyof typeof BAND];

export interface BoundaryEntry {
  action: string;
  class: ToolClass;
  band: Band;
  /** Whether Memnox could put it back. An input to the band, not a note beside it. */
  reversibility: Reversibility;
  /** The rule that put it there, when one did. */
  because: string;
}

export interface Boundary {
  agent: string;
  entries: BoundaryEntry[];
  /** Capabilities nothing has an opinion about. Counted, never called safe. */
  ungoverned: string[];
}

const BANDS: Readonly<Record<DecisionEffect, Band>> = {
  [DECISION_EFFECT.ALLOW]: BAND.AUTOMATIC,
  [DECISION_EFFECT.ASK]: BAND.NEEDS_APPROVAL,
  [DECISION_EFFECT.DENY]: BAND.NEVER,
};

export interface CandidateAction {
  action: string;
  class: ToolClass;
}

/**
 * Every action a CLI on this machine could take, from its verb table.
 *
 * The tables are the same ones enforcement reads, so a boundary drawn here cannot
 * promise something the gate would decide differently.
 */
export function actionsForCli(binary: string): CandidateAction[] {
  const table = verbTableFor(binary);
  if (table === null) return [];
  return table.verbs.map((verb) => ({
    action: verbAction(binary, verb),
    class: verb.class,
  }));
}

export function boundaryFor(
  agent: string,
  candidates: readonly CandidateAction[],
  decide: (action: string) => {
    effect: DecisionEffect;
    reason: string;
    matched: boolean;
  },
): Boundary {
  const entries: BoundaryEntry[] = [];
  const ungoverned: string[] = [];

  for (const candidate of candidates) {
    const verdict = decide(candidate.action);
    if (!verdict.matched) {
      /* Nothing has an opinion about this. Counted rather than filed under
         "automatic": an unruled capability is not a permitted one, and putting it in
         the allowed band would be the screen telling a comfortable lie. */
      ungoverned.push(candidate.action);
      continue;
    }
    const band = BANDS[verdict.effect] ?? BAND.NEEDS_APPROVAL;
    const reversibility = reversibilityOf(candidate.action, candidate.class);
    /* An allow is not enough on its own. Something Memnox cannot put back is never
       handed over unattended, however ordinary the rule that permits it: the cost of
       a wrong ask is an interruption, and the cost of a wrong send is a sent email. */
    const held = band === BAND.AUTOMATIC && !mayBeAutomatic(reversibility);
    entries.push({
      action: candidate.action,
      class: candidate.class,
      band: held ? BAND.NEEDS_APPROVAL : band,
      reversibility,
      because: held
        ? `${verdict.reason} — but ${describeReversibility(reversibility)}`
        : verdict.reason,
    });
  }

  return {
    agent,
    entries: entries.sort((a, b) => a.action.localeCompare(b.action)),
    ungoverned: ungoverned.sort(),
  };
}

export function inBand(boundary: Boundary, band: Band): BoundaryEntry[] {
  return boundary.entries.filter((entry) => entry.band === band);
}

/**
 * How far a mistake would reach, from what the agent actually holds.
 *
 * Shown before somebody turns autonomy on, because that is the moment the question is
 * live. Built from credentials and classes found on the machine — never a score, and
 * never a reassurance: the honest version of this screen sometimes says the blast
 * radius is large and offers to narrow it.
 */
export interface BlastRadius {
  /** Credential kinds the agent can read, by name. Never a value. */
  credentials: string[];
  /** How many actions in each band, which is the shape of the boundary. */
  automatic: number;
  needsApproval: number;
  never: number;
  ungoverned: number;
  /** True when something destructive runs without being asked about. */
  destructiveAutomatic: boolean;
}

export function blastRadiusOf(
  boundary: Boundary,
  credentials: readonly string[],
): BlastRadius {
  const automatic = inBand(boundary, BAND.AUTOMATIC);
  return {
    credentials: [...credentials].sort(),
    automatic: automatic.length,
    needsApproval: inBand(boundary, BAND.NEEDS_APPROVAL).length,
    never: inBand(boundary, BAND.NEVER).length,
    ungoverned: boundary.ungoverned.length,
    destructiveAutomatic: automatic.some(
      (entry) => entry.class === TOOL_CLASS.DESTRUCTIVE,
    ),
  };
}

/**
 * Whether this is a boundary somebody should be allowed to switch on unexamined.
 *
 * Two things stop it, and both are cases where the screen would otherwise read as
 * reassuring while being wrong: something destructive running unasked, and a majority
 * of what the agent can do having no rule about it at all.
 */
export function readyToEnable(radius: BlastRadius): { ready: boolean; because: string } {
  if (radius.destructiveAutomatic) {
    return {
      ready: false,
      because: 'something destructive would run without asking',
    };
  }
  const ruled = radius.automatic + radius.needsApproval + radius.never;
  if (radius.ungoverned > ruled) {
    return {
      ready: false,
      because: `${radius.ungoverned} capabilities have no rule at all, more than the ${ruled} that do`,
    };
  }
  return { ready: true, because: 'every destructive action is held or refused' };
}

/**
 * The jobs the rules on this machine actually name.
 *
 * A workforce is several agents holding different authority, and the question people
 * have is "who is allowed to do what" rather than "what may this binary do". Read from
 * the rules rather than from a roster, because a role nothing has a rule about is a
 * name somebody typed once — it governs nothing and listing it would suggest otherwise.
 */
export function rolesIn(policies: readonly Policy[]): string[] {
  const named = new Set<string>();
  for (const policy of policies) {
    for (const role of policy.match.roles ?? []) {
      // A wildcard is every role rather than a role, so it names nobody in a roster.
      if (role !== '*' && role.trim() !== '') named.add(role);
    }
  }
  return [...named].sort();
}

/** What one job may do, counted per band, for the table that compares them. */
export interface RoleStanding {
  role: string;
  automatic: number;
  needsApproval: number;
  never: number;
}

export function standingFor(role: string, boundary: Boundary): RoleStanding {
  const count = (band: Band): number =>
    boundary.entries.filter((entry) => entry.band === band).length;
  return {
    role,
    automatic: count(BAND.AUTOMATIC),
    needsApproval: count(BAND.NEEDS_APPROVAL),
    never: count(BAND.NEVER),
  };
}
