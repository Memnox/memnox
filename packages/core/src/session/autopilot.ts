import { DECISION_EFFECT, type DecisionEffect } from '../constants/decision.constants';
import { TOOL_CLASS, type ToolClass } from '../discovery/classify';
import { verbAction, verbTableFor } from '../verbs/index';
import type { Policy } from '../policy/policy';
import {
  describeReversibility,
  canBeAutomatic,
  reversibilityOf,
  type Reversibility,
} from './reversibility';

/**
 * Whether an agent can be left running, as three bands in plain words, each line the
 * verdict the engine actually reaches for that action rather than what the rules intend.
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

/** Every action a CLI could take, from the same verb tables enforcement reads. */
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
  // The class goes too, or a rule written about changes decides a read as well.
  decide: (
    action: string,
    toolClass: ToolClass,
  ) => {
    effect: DecisionEffect;
    reason: string;
    matched: boolean;
  },
): Boundary {
  const entries: BoundaryEntry[] = [];
  const ungoverned: string[] = [];

  for (const candidate of candidates) {
    const verdict = decide(candidate.action, candidate.class);
    if (!verdict.matched) {
      // Counted rather than filed as automatic, because an unruled capability is not a permitted one.
      ungoverned.push(candidate.action);
      continue;
    }
    const band = BANDS[verdict.effect] ?? BAND.NEEDS_APPROVAL;
    const reversibility = reversibilityOf(candidate.action, candidate.class);
    // Something Memnox cannot put back is never unattended: a wrong ask costs an
    // interruption, and a wrong send is a sent email.
    const held = band === BAND.AUTOMATIC && !canBeAutomatic(reversibility);
    entries.push({
      action: candidate.action,
      class: candidate.class,
      band: held ? BAND.NEEDS_APPROVAL : band,
      reversibility,
      because: held
        ? `${verdict.reason}, but ${describeReversibility(reversibility)}`
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
 * How far a mistake would reach, from the credentials and classes on this machine,
 * shown before autonomy is turned on. Never a score and never a reassurance.
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
 * Whether this boundary can be switched on unexamined: not while something destructive
 * runs unasked, nor while most of the reach has no rule.
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

/** The jobs the rules actually name, since a role no rule mentions governs nothing. */
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
  return {
    role,
    automatic: inBand(boundary, BAND.AUTOMATIC).length,
    needsApproval: inBand(boundary, BAND.NEEDS_APPROVAL).length,
    never: inBand(boundary, BAND.NEVER).length,
  };
}
