import { beforeEach, describe, expect, it } from 'vitest';
import { DELEGATION_REFUSAL, type Delegation } from '@memnox/core';
import {
  DelegationService,
  DELEGATION_UNKNOWN_PARENT,
  InMemoryDelegationStore,
} from '../src/delegation-service';
import { CONSOLE_LOGGER } from '../src/console-logger';

const NOW = new Date('2026-08-31T09:00:00.000Z');
const NEXT_WEEK = '2026-09-07T09:00:00.000Z';
const NEXT_MONTH = '2026-09-30T09:00:00.000Z';

describe('the chain of command', () => {
  let store: InMemoryDelegationStore;
  let delegations: DelegationService;

  const root = async (over: Partial<Delegation> = {}) => {
    const outcome = await delegations.issue({
      issuerId: 'moise',
      delegateId: 'agt_release',
      actions: ['deploy.*', 'repository.read'],
      transferable: true,
      expiresAt: NEXT_WEEK,
      ceilings: { budgetCents: 10_000 },
      ...over,
    });
    if (!outcome.issued) throw new Error(outcome.reason);
    return outcome.delegation;
  };

  beforeEach(() => {
    store = new InMemoryDelegationStore();
    delegations = new DelegationService({
      store,
      logger: CONSOLE_LOGGER,
      clock: () => NOW,
    });
  });

  it('issues a root delegation from a person', async () => {
    const delegation = await root();

    expect(delegation.issuerId).toBe('moise');
    expect(await delegations.mayAct('agt_release', 'deploy.staging')).toBe(true);
  });

  it('refuses to pass on what the issuer does not hold', async () => {
    const parent = await root();

    const outcome = await delegations.issue({
      issuerId: 'agt_release',
      delegateId: 'agt_helper',
      actions: ['database.delete'],
      expiresAt: NEXT_WEEK,
      parentId: parent.id,
    });

    expect(outcome).toEqual({ issued: false, reason: DELEGATION_REFUSAL.NOT_HELD });
  });

  it('refuses to outlive the delegation it narrows', async () => {
    const parent = await root();

    const outcome = await delegations.issue({
      issuerId: 'agt_release',
      delegateId: 'agt_helper',
      actions: ['deploy.staging'],
      expiresAt: NEXT_MONTH,
      parentId: parent.id,
    });

    expect(outcome).toEqual({ issued: false, reason: DELEGATION_REFUSAL.NOT_HELD });
  });

  it('refuses to raise a ceiling on the way down', async () => {
    const parent = await root();

    const outcome = await delegations.issue({
      issuerId: 'agt_release',
      delegateId: 'agt_helper',
      actions: ['deploy.staging'],
      expiresAt: NEXT_WEEK,
      parentId: parent.id,
      ceilings: { budgetCents: 50_000 },
    });

    expect(outcome).toEqual({ issued: false, reason: DELEGATION_REFUSAL.NOT_HELD });
  });

  it('refuses to pass on authority that was not marked transferable', async () => {
    const parent = await root({ transferable: false });

    const outcome = await delegations.issue({
      issuerId: 'agt_release',
      delegateId: 'agt_helper',
      actions: ['deploy.staging'],
      expiresAt: NEXT_WEEK,
      parentId: parent.id,
    });

    expect(outcome).toEqual({
      issued: false,
      reason: DELEGATION_REFUSAL.NOT_TRANSFERABLE,
    });
  });

  it('lets an agent hand narrower work to another agent', async () => {
    const parent = await root();

    const outcome = await delegations.issue({
      issuerId: 'agt_release',
      delegateId: 'agt_helper',
      actions: ['deploy.staging'],
      expiresAt: NEXT_WEEK,
      parentId: parent.id,
      ceilings: { budgetCents: 1_000 },
    });

    expect(outcome.issued).toBe(true);
    expect(await delegations.mayAct('agt_helper', 'deploy.staging')).toBe(true);
  });

  it('kills the child when the parent is revoked, checked at use rather than at issue', async () => {
    const parent = await root();
    const child = await delegations.issue({
      issuerId: 'agt_release',
      delegateId: 'agt_helper',
      actions: ['deploy.staging'],
      expiresAt: NEXT_WEEK,
      parentId: parent.id,
      ceilings: { budgetCents: 1_000 },
    });
    expect(child.issued).toBe(true);

    await delegations.revoke(parent.id);

    // A revoked person must not leave a live chain behind them.
    expect(await delegations.mayAct('agt_helper', 'deploy.staging')).toBe(false);
  });

  it('prints the chain from the person at the root to the agent acting', async () => {
    const parent = await root();
    const child = await delegations.issue({
      issuerId: 'agt_release',
      delegateId: 'agt_helper',
      actions: ['deploy.staging'],
      expiresAt: NEXT_WEEK,
      parentId: parent.id,
      ceilings: { budgetCents: 1_000 },
    });
    if (!child.issued) throw new Error('not issued');

    const chain = await delegations.chain(child.delegation.id);

    expect(chain.map((link) => link.issuerId)).toEqual(['moise', 'agt_release']);
  });

  it('refuses to narrow a delegation that does not exist', async () => {
    const outcome = await delegations.issue({
      issuerId: 'agt_release',
      delegateId: 'agt_helper',
      actions: ['deploy.staging'],
      expiresAt: NEXT_WEEK,
      parentId: 'nope',
    });

    expect(outcome).toEqual({ issued: false, reason: DELEGATION_UNKNOWN_PARENT });
  });
});
