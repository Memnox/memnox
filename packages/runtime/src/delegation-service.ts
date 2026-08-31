import { randomUUID } from 'node:crypto';
import type { Delegation, Logger } from '@memnox/core';
import { canDelegate, chainOf, isDelegationLive } from '@memnox/core';
import { matchesAny } from '@memnox/policy-engine';

export interface DelegationStore {
  save(delegation: Delegation): Promise<void>;
  findById(id: string): Promise<Delegation | null>;
  listByDelegate(delegateId: string): Promise<Delegation[]>;
  list(): Promise<Delegation[]>;
}

export class InMemoryDelegationStore implements DelegationStore {
  private readonly byId = new Map<string, Delegation>();

  async save(delegation: Delegation): Promise<void> {
    this.byId.set(delegation.id, delegation);
  }

  async findById(id: string): Promise<Delegation | null> {
    return this.byId.get(id) ?? null;
  }

  async listByDelegate(delegateId: string): Promise<Delegation[]> {
    return [...this.byId.values()].filter((each) => each.delegateId === delegateId);
  }

  async list(): Promise<Delegation[]> {
    return [...this.byId.values()];
  }
}

export interface IssueRequest {
  issuerId: string;
  delegateId: string;
  actions: string[];
  scope?: Record<string, string>;
  transferable?: boolean;
  expiresAt: string;
  /** The delegation this one narrows. Absent means it comes from a person. */
  parentId?: string;
  ceilings?: { budgetCents?: number; maxRisk?: string; resourceScope?: string[] };
}

export type IssueOutcome =
  { issued: true; delegation: Delegation } | { issued: false; reason: string };

export const DELEGATION_UNKNOWN_PARENT = 'the delegation it narrows does not exist';

export interface DelegationDeps {
  store: DelegationStore;
  logger: Logger;
  clock?: () => Date;
}

/**
 * Every agent's authority came from somewhere: not an API key, a person, through a
 * chain the product can print. Checked at issue against the issuer's authority and
 * again at use, because the issuer's authority may have been revoked since.
 */
export class DelegationService {
  private readonly clock: () => Date;

  constructor(private readonly deps: DelegationDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  async issue(request: IssueRequest): Promise<IssueOutcome> {
    let parent: Delegation | null = null;
    if (request.parentId !== undefined) {
      parent = await this.deps.store.findById(request.parentId);
      if (parent === null) return { issued: false, reason: DELEGATION_UNKNOWN_PARENT };
    }

    const delegation: Delegation = {
      id: randomUUID(),
      issuerId: request.issuerId,
      delegateId: request.delegateId,
      authority: {
        actions: [...request.actions],
        ...(request.ceilings === undefined ? {} : { ceilings: request.ceilings }),
      },
      scope: request.scope ?? {},
      transferable: request.transferable === true,
      expiresAt: request.expiresAt,
      ...(request.parentId === undefined ? {} : { parentId: request.parentId }),
    };

    const check = canDelegate(parent, delegation, this.clock(), (patterns, value) =>
      matchesAny([...patterns], value),
    );
    if (!check.ok) return { issued: false, reason: check.reason };

    await this.deps.store.save(delegation);
    return { issued: true, delegation };
  }

  /**
   * Checked again at use: a chain whose issuer was revoked yesterday must not still
   * carry authority today, and only checking at issue would leave exactly that.
   */
  async mayAct(delegateId: string, action: string): Promise<boolean> {
    const now = this.clock();
    for (const delegation of await this.deps.store.listByDelegate(delegateId)) {
      if (!isDelegationLive(delegation, now).ok) continue;
      if (!matchesAny([...delegation.authority.actions], action)) continue;
      const chain = chainOf(delegation, await this.byId());
      if (chain.every((link) => isDelegationLive(link, now).ok)) return true;
    }
    return false;
  }

  /** The chain the product can print, from the person at the root to the agent acting. */
  async chain(delegationId: string): Promise<Delegation[]> {
    const delegation = await this.deps.store.findById(delegationId);
    if (delegation === null) return [];
    return chainOf(delegation, await this.byId());
  }

  async revoke(delegationId: string): Promise<boolean> {
    const delegation = await this.deps.store.findById(delegationId);
    if (delegation === null) return false;
    await this.deps.store.save({
      ...delegation,
      revokedAt: this.clock().toISOString(),
    });
    return true;
  }

  private async byId(): Promise<Map<string, Delegation>> {
    return new Map((await this.deps.store.list()).map((each) => [each.id, each]));
  }
}
