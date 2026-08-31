import type { EnforcementMode } from '../constants/enforcement.constants';
import {
  DEFAULT_SEAM_UNHEALTHY,
  type SeamKind,
  type SeamUnhealthyBehaviour,
} from '../constants/seam.constants';
import { ENFORCEMENT_MODE } from '../constants/enforcement.constants';

export interface Seam {
  id: string;
  agentId: string;
  kind: SeamKind;
  mode: EnforcementMode;
  /** Action globs this seam actually sees. */
  covers: string[];
  /** Declared, and shown wherever coverage is reported. */
  blindTo: string[];
  /** The harden step that installed it, so uninstalling is one command. */
  installedBy?: string;
  lastSeenAt?: string;
  /** Chosen per environment: what this seam does when the runtime is unhealthy. */
  whenUnhealthy: SeamUnhealthyBehaviour;
}

export interface SeamSummary {
  kind: SeamKind;
  mode: EnforcementMode;
  blindTo: string[];
}

export function seamSummaryOf(seam: Seam): SeamSummary {
  return { kind: seam.kind, mode: seam.mode, blindTo: [...seam.blindTo] };
}

/**
 * An agent governed on one of four seams is not a governed agent, and the number has
 * to say so. Coverage is the share of its seams actually enforcing, never a boolean.
 */
export function seamCoverage(seams: readonly Seam[]): {
  enforcing: number;
  total: number;
  blindTo: string[];
} {
  const enforcing = seams.filter((seam) => seam.mode === ENFORCEMENT_MODE.ENFORCE).length;
  const blindTo = [...new Set(seams.flatMap((seam) => seam.blindTo))];
  return { enforcing, total: seams.length, blindTo };
}

export function newSeam(
  input: Omit<Seam, 'whenUnhealthy'> & { whenUnhealthy?: SeamUnhealthyBehaviour },
): Seam {
  return { ...input, whenUnhealthy: input.whenUnhealthy ?? DEFAULT_SEAM_UNHEALTHY };
}

export interface SeamStore {
  save(seam: Seam): Promise<void>;
  listByAgent(agentId: string): Promise<Seam[]>;
  list(): Promise<Seam[]>;
  remove(id: string): Promise<boolean>;
}
