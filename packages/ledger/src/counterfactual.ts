import { COUNTERFACTUAL_BASIS } from './ledger.constants';

export interface ResourceRef {
  id: string;
  kind: string;
  path?: string;
}

/**
 * What the withheld action would have reached, derived from the attempt that was
 * actually made and from nothing else. Never speculative: a counterfactual that
 * imagined a wider blast radius would be the estimated-loss figure in another costume.
 */
export interface Counterfactual {
  decisionId: string;
  attempted: { action: string; resource?: string };
  wouldHaveReached: ResourceRef[];
  basis: typeof COUNTERFACTUAL_BASIS;
}

export interface CounterfactualInput {
  decisionId: string;
  action: string;
  resource?: string;
  /** Reachability computed at discovery: what this agent can touch, already known. */
  reachable: readonly ResourceRef[];
}

export function computeCounterfactual(input: CounterfactualInput): Counterfactual {
  const target = input.resource;
  // Only what the attempt itself named. Everything else is a guess about a future.
  const wouldHaveReached =
    target === undefined
      ? []
      : input.reachable.filter(
          (resource) => resource.path === target || resource.id === target,
        );
  return {
    decisionId: input.decisionId,
    attempted: {
      action: input.action,
      ...(target === undefined ? {} : { resource: target }),
    },
    wouldHaveReached,
    basis: COUNTERFACTUAL_BASIS,
  };
}
