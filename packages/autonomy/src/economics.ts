import {
  SYNTHESIS_MIN_AGREEMENT,
  SYNTHESIS_MIN_SUPPORT,
  type DetectorKind,
} from './autonomy.constants';

/**
 * Measured, except the last field, which the customer supplies. Presenting a modelled
 * number in our own voice is the same mistake as an estimated risk exposure.
 */
export interface RoleEconomics {
  roleId: string;
  window: string;
  actions: number;
  tasksCompleted: number;
  tasksAbandoned: number;
  interventions: number;
  interventionRate: number;
  retriedActions: number;
  refusedActions: number;
  cents: number;
  centsPerCompletedTask: number;
  wastedCents: number;
  /** Their assumption, labelled. Never ours. */
  humanRatePerHour?: number;
}

export interface EconomicsInput {
  roleId: string;
  window: string;
  actions: number;
  tasksCompleted: number;
  tasksAbandoned: number;
  interventions: number;
  retriedActions: number;
  refusedActions: number;
  cents: number;
  wastedCents: number;
  humanRatePerHour?: number;
}

/** Cost per completed task, not cost per token: the second is a bill, not a measure. */
export function computeRoleEconomics(input: EconomicsInput): RoleEconomics {
  const attempted = input.tasksCompleted + input.tasksAbandoned;
  return {
    ...input,
    interventionRate: attempted === 0 ? 0 : input.interventions / attempted,
    centsPerCompletedTask:
      input.tasksCompleted === 0 ? 0 : input.cents / input.tasksCompleted,
  };
}

export interface ApprovalRecord {
  id: string;
  action: string;
  decidedBy: string;
  granted: boolean;
}

export interface RuleSynthesis {
  id: string;
  workspaceId: string;
  fromApprovals: string[];
  support: number;
  agreement: number;
  /** A phase 05 object, unchanged: nothing gets a private path into policy. */
  proposalDraft: { action: string; effect: string; reason: string };
}

/**
 * Repeated identical approvals are a rule waiting to be written. Support and agreement
 * both clear a bar, and one dissent resets it — a rule synthesised over a disagreement
 * would put words in somebody's mouth.
 */
export function synthesizeRule(
  workspaceId: string,
  action: string,
  approvals: readonly ApprovalRecord[],
): RuleSynthesis | null {
  const forAction = approvals.filter((approval) => approval.action === action);
  if (forAction.length < SYNTHESIS_MIN_SUPPORT) return null;
  const granted = forAction.filter((approval) => approval.granted).length;
  const dissent = forAction.length - granted;
  if (dissent > 0) return null;
  const distinctApprovers = new Set(forAction.map((approval) => approval.decidedBy)).size;
  if (distinctApprovers < SYNTHESIS_MIN_AGREEMENT) return null;

  return {
    id: `syn_${action}`,
    workspaceId,
    fromApprovals: forAction.map((approval) => approval.id),
    support: forAction.length,
    agreement: distinctApprovers,
    proposalDraft: {
      action,
      effect: 'allow',
      reason: `Approved ${forAction.length} times with no dissent.`,
    },
  };
}

/** A detector nobody measured is a mute button waiting to be pressed. */
export interface Detector {
  id: string;
  kind: DetectorKind;
  schedule: string;
  params: Record<string, string>;
  /** Scored against the ledger before it ever acts alone. */
  precisionToDate?: number;
}

export const DETECTOR_MIN_PRECISION_TO_ACT_ALONE = 0.9;

/** Detection proposes containment; a person confirms it until the record says otherwise. */
export function mayActAlone(detector: Detector): boolean {
  const precision = detector.precisionToDate;
  if (precision === undefined) return false;
  return precision >= DETECTOR_MIN_PRECISION_TO_ACT_ALONE;
}
