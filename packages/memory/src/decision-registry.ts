import { randomUUID } from 'node:crypto';
import { fingerprintDecision } from './decision-fingerprint';
import {
  DECISION_SOURCE_MANUAL,
  DECISION_STATUS,
  isEnforcing,
  type DecisionEnforcement,
  type DecisionRecord,
  type DecisionStatus,
  type DecisionStore,
  type ReversibilityCost,
} from './decision-record';

export interface NewDecisionInput {
  title: string;
  statement: string;
  owner: string;
  actions: string[];
  targets?: string[];
  environments?: string[];
  enforcement: DecisionEnforcement;
  reversibilityCost?: ReversibilityCost;
  sourceType?: string;
  sourceRef?: string;
  reviewAfter?: string;
  /** ID of an existing decision this one replaces. */
  supersedes?: string;
}

export type RegisterDecisionOutcome =
  | { ok: true; record: DecisionRecord }
  | { ok: false; reason: 'duplicate'; existingId: string }
  | { ok: false; reason: 'supersede-target-missing' };

/**
 * Application service owning the decision-corpus invariants: restatements
 * converge to one constraint (fingerprint dedup), supersession chains stay
 * intact, and status changes go through here — transports stay thin.
 */
export class DecisionRegistry {
  constructor(private readonly store: DecisionStore) {}

  async register(input: NewDecisionInput): Promise<RegisterDecisionOutcome> {
    const record: DecisionRecord = {
      id: randomUUID(),
      title: input.title,
      statement: input.statement,
      owner: input.owner,
      decidedAt: new Date().toISOString(),
      actions: input.actions,
      targets: input.targets,
      environments: input.environments,
      enforcement: input.enforcement,
      status: DECISION_STATUS.ACTIVE,
      reversibilityCost: input.reversibilityCost,
      sourceType: input.sourceType ?? DECISION_SOURCE_MANUAL,
      sourceRef: input.sourceRef,
      reviewAfter: input.reviewAfter,
    };

    const existing = await this.store.list();
    const fingerprint = fingerprintDecision(record);
    const duplicate = existing.find(
      (candidate) =>
        candidate.id !== input.supersedes &&
        isEnforcing(candidate) &&
        fingerprintDecision(candidate) === fingerprint,
    );
    if (duplicate) return { ok: false, reason: 'duplicate', existingId: duplicate.id };

    if (input.supersedes) {
      const superseded = existing.find((candidate) => candidate.id === input.supersedes);
      if (!superseded) return { ok: false, reason: 'supersede-target-missing' };
      await this.store.save({
        ...superseded,
        status: DECISION_STATUS.SUPERSEDED,
        supersededById: record.id,
      });
    }

    await this.store.save(record);
    return { ok: true, record };
  }

  async setStatus(id: string, status: DecisionStatus): Promise<DecisionRecord | null> {
    const decision = (await this.store.list()).find((candidate) => candidate.id === id);
    if (!decision) return null;
    const updated: DecisionRecord = { ...decision, status };
    await this.store.save(updated);
    return updated;
  }
}
