import { describe, expect, it } from 'vitest';
import { AUTHORITY_SIGNAL, evaluateAuthority, type AuthorityGrant } from '../src/index';

const NOW = new Date('2026-06-01T12:00:00.000Z');

const grant = (over: Partial<AuthorityGrant> = {}): AuthorityGrant => ({
  id: 'grant-1',
  workspaceId: 'acme',
  principal: 'alice',
  actions: ['payment.refund'],
  grantedBy: 'alice',
  grantedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const ask = (
  grants: AuthorityGrant[],
  over: Partial<Parameters<typeof evaluateAuthority>[1]> = {},
): ReturnType<typeof evaluateAuthority> =>
  evaluateAuthority(
    grants,
    {
      principal: 'alice',
      agentName: 'assistant',
      action: 'payment.refund',
      amount: 100,
      ...over,
    },
    NOW,
  );

describe('evaluateAuthority', () => {
  it('says nothing when the action names no principal', () => {
    expect(ask([grant({ limit: 1 })], { principal: undefined })).toBeNull();
  });

  it('says nothing about a principal the organization has not recorded', () => {
    expect(ask([grant({ principal: 'bob', limit: 1 })])).toBeNull();
  });

  it('escalates an action outside a recorded principal’s remit', () => {
    const verdict = ask([grant({ actions: ['email.draft'] })], {
      action: 'contract.sign',
    });

    expect(verdict?.escalateTo).toBe('require_approval');
    expect(verdict?.signal).toBe(AUTHORITY_SIGNAL.NO_GRANT);
    expect(verdict?.reason).toContain('contract.sign');
  });

  it('allows an amount at the ceiling', () => {
    expect(ask([grant({ limit: 100 })], { amount: 100 })).toBeNull();
  });

  it('escalates an amount above the ceiling, naming the principal as approver', () => {
    const verdict = ask([grant({ limit: 5_000 })], { amount: 5_001 });

    expect(verdict?.escalateTo).toBe('require_approval');
    expect(verdict?.signal).toBe(AUTHORITY_SIGNAL.OVER_CEILING);
    expect(verdict?.approvers).toContain('alice');
  });

  it('blocks past the ceiling when the grant says so', () => {
    const verdict = ask([grant({ limit: 10, overLimit: 'block' })], { amount: 99 });

    expect(verdict?.escalateTo).toBe('block');
  });

  it('takes the highest ceiling when several grants cover the action', () => {
    const grants = [
      grant({ id: 'low', limit: 100 }),
      grant({ id: 'high', limit: 10_000 }),
    ];

    expect(ask(grants, { amount: 9_000 })).toBeNull();
    expect(ask(grants, { amount: 10_001 })?.signal).toBe(AUTHORITY_SIGNAL.OVER_CEILING);
  });

  it('does not let an action escape a ceiling by omitting its size', () => {
    const verdict = ask([grant({ limit: 5_000 })], { amount: undefined });

    expect(verdict?.escalateTo).toBe('require_approval');
    expect(verdict?.reason).toContain('does not say how big it is');
  });

  it('leaves an uncapped grant alone whatever the amount', () => {
    expect(ask([grant()], { amount: 1_000_000 })).toBeNull();
  });

  it('escalates once a temporary delegation has run out', () => {
    const verdict = ask([grant({ limit: 5_000, expiresAt: '2026-06-01T11:00:00.000Z' })]);

    expect(verdict?.signal).toBe(AUTHORITY_SIGNAL.EXPIRED);
  });

  it('honours a delegation that has not yet run out', () => {
    expect(
      ask([grant({ limit: 5_000, expiresAt: '2026-06-01T13:00:00.000Z' })]),
    ).toBeNull();
  });

  it('scopes a grant to the agents it names', () => {
    const grants = [grant({ agents: ['finance-bot'], limit: 5_000 })];

    expect(ask(grants, { agentName: 'finance-bot' })).toBeNull();
    expect(ask(grants, { agentName: 'assistant' })?.signal).toBe(
      AUTHORITY_SIGNAL.NO_GRANT,
    );
  });

  it("separates a person's authority from the authority their agent carries", () => {
    // Alice may approve 50,000; what she delegated to her assistant is 5,000.
    const grants = [grant({ limit: 5_000, agents: ['assistant'] })];

    expect(ask(grants, { amount: 4_999 })).toBeNull();
    expect(ask(grants, { amount: 50_000 })?.escalateTo).toBe('require_approval');
  });
});
