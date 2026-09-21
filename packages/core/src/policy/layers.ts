import { EFFECT_PRECEDENCE, type DecisionEffect } from '../constants/decision.constants';
import type { Policy } from './policy';

/**
 * Three layers, strongest first: an organization sets a floor, a person their defaults,
 * a project narrows further. A project may tighten anything and loosen nothing locked.
 */
export const POLICY_LAYER = {
  ORG: 'org',
  USER: 'user',
  PROJECT: 'project',
} as const;

export type PolicyLayer = (typeof POLICY_LAYER)[keyof typeof POLICY_LAYER];

/** Outermost first: later layers are read against what earlier ones already said. */
export const LAYER_ORDER: readonly PolicyLayer[] = [
  POLICY_LAYER.ORG,
  POLICY_LAYER.USER,
  POLICY_LAYER.PROJECT,
];

export interface LayeredPolicy {
  layer: PolicyLayer;
  policy: Policy;
  /** The file it came from, so `why` can print a path somebody can open. */
  file: string;
}

export interface PolicyStack {
  policies: LayeredPolicy[];
  /**
   * Domains an outer layer sealed. A rule in a later layer touching one of these can
   * only make it stricter, and one that would loosen it is refused rather than applied.
   */
  locked: string[];
}

export interface LayerInput {
  layer: PolicyLayer;
  file: string;
  policies: readonly Policy[];
  /** Action prefixes this layer seals, e.g. "database." or "deploy.". */
  locked?: readonly string[];
}

export interface StackRefusal {
  policy: string;
  layer: PolicyLayer;
  file: string;
  reason: string;
}

function isLocked(action: string, locked: readonly string[]): boolean {
  return locked.some((prefix) => action.startsWith(prefix));
}

function actionsOf(policy: Policy): readonly string[] {
  return policy.match.actions ?? [];
}

/** How strict an effect is; an effect this build does not know counts as the loosest. */
function strictnessOf(effect: DecisionEffect): number {
  // A hand-written file can carry any string, so the lookup may miss.
  return (EFFECT_PRECEDENCE as Record<string, number | undefined>)[effect] ?? 0;
}

/** Whether a later rule would loosen an action an outer layer already locked. */
function loosensLocked(
  policy: Policy,
  stack: PolicyStack,
  floor: ReadonlyMap<string, number>,
): boolean {
  const strength = strictnessOf(policy.decision.effect);
  return actionsOf(policy).some((action) => {
    if (!isLocked(action, stack.locked)) return false;
    const existing = floor.get(action);
    return existing !== undefined && strength < existing;
  });
}

/** Records the strictest effect seen for each action this policy names. */
function raiseFloor(policy: Policy, floor: Map<string, number>): void {
  const strength = strictnessOf(policy.decision.effect);
  for (const action of actionsOf(policy)) {
    const existing = floor.get(action);
    if (existing === undefined || strength > existing) floor.set(action, strength);
  }
}

/**
 * A refusal here is not an error to swallow: a project that thought it had loosened a
 * locked rule and silently did not would be governed by something nobody can see.
 */
export function buildStack(layers: readonly LayerInput[]): {
  stack: PolicyStack;
  refused: StackRefusal[];
} {
  const ordered = [...layers].sort(
    (a, b) => LAYER_ORDER.indexOf(a.layer) - LAYER_ORDER.indexOf(b.layer),
  );
  const stack: PolicyStack = { policies: [], locked: [] };
  const refused: StackRefusal[] = [];
  // The strictest effect any earlier layer set, keyed by action pattern.
  const floor = new Map<string, number>();

  for (const input of ordered) {
    for (const policy of input.policies) {
      if (loosensLocked(policy, stack, floor)) {
        refused.push({
          policy: policy.name,
          layer: input.layer,
          file: input.file,
          reason: `it would loosen a rule an outer layer locked; a ${input.layer} rule may only tighten`,
        });
        continue;
      }
      raiseFloor(policy, floor);
      stack.policies.push({ layer: input.layer, policy, file: input.file });
    }
    stack.locked.push(...(input.locked ?? []));
  }
  return { stack, refused };
}

/** The engine takes plain policies; the layer rides alongside for `why`. */
export function policiesOf(stack: PolicyStack): Policy[] {
  return stack.policies.map((entry) => entry.policy);
}

export function layerOf(stack: PolicyStack, policyName: string): LayeredPolicy | null {
  return stack.policies.find((entry) => entry.policy.name === policyName) ?? null;
}
