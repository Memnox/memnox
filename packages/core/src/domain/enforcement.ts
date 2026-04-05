import { DECISION_EFFECT, type DecisionEffect } from '../constants/decision.constants';
import {
  DEFAULT_ENFORCEMENT_MODE,
  ENFORCEMENT_MODE,
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
  /** What policy decided, when the mode kept it from being applied. */
  withheldEffect?: DecisionEffect;
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
 * Separates the verdict from its application. Monitor mode must never rewrite
 * the verdict — an audit record that claims it blocked when it did not is worse
 * than no record at all.
 */
export function applyEnforcementMode(
  verdict: DecisionEffect,
  mode: EnforcementMode,
): AppliedDecision {
  if (mode === ENFORCEMENT_MODE.ENFORCE) return { effect: verdict };
  if (verdict === DECISION_EFFECT.ALLOW) return { effect: DECISION_EFFECT.ALLOW };
  return { effect: DECISION_EFFECT.ALLOW, withheldEffect: verdict };
}
