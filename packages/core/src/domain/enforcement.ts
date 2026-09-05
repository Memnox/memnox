import { DECISION_EFFECT, type DecisionEffect } from '../constants/decision.constants';
import {
  DEFAULT_ENFORCEMENT_MODE,
  ENFORCEMENT_MODE,
  MODE_STRENGTH,
  type EnforcementMode,
} from '../constants/enforcement.constants';

/** Per-environment modes; an environment absent from the map takes the default. */
export interface EnvironmentModes {
  default?: EnforcementMode;
  environments?: Record<string, EnforcementMode>;
}

export interface AppliedDecision {
  /** What actually happened to the action. */
  effect: DecisionEffect;
  /** What enforce would have said, when the mode kept it from being applied. */
  shadowEffect?: DecisionEffect;
}

export function isEnforcementMode(value: unknown): value is EnforcementMode {
  return (
    typeof value === 'string' &&
    (Object.values(ENFORCEMENT_MODE) as string[]).includes(value)
  );
}

/** Environment names are compared case-insensitively; "PROD" and "prod" are one environment. */
export function resolveEnforcementMode(
  modes: EnvironmentModes,
  environment: string | undefined,
): EnforcementMode {
  const fallback = modes.default ?? DEFAULT_ENFORCEMENT_MODE;
  if (environment === undefined) return fallback;
  const configured = modes.environments;
  if (configured === undefined) return fallback;
  const match = Object.keys(configured).find(
    (name) => name.toLowerCase() === environment.toLowerCase(),
  );
  if (match === undefined) return fallback;
  const mode = configured[match];
  return mode === undefined ? fallback : mode;
}

/**
 * Mode downgrades the effect and never the reverse. Observe and advise must never rewrite
 * what was decided: phase 03 has nothing to report and simulation nothing to replay unless
 * the real verdict is computed and kept beside the permissive one.
 */
export function applyEnforcementMode(
  verdict: DecisionEffect,
  mode: EnforcementMode,
): AppliedDecision {
  if (mode === ENFORCEMENT_MODE.ENFORCE) return { effect: verdict };
  if (verdict === DECISION_EFFECT.ALLOW) return { effect: DECISION_EFFECT.ALLOW };
  return { effect: DECISION_EFFECT.ALLOW, shadowEffect: verdict };
}
