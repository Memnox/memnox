import { describe, expect, it } from 'vitest';
import { APPROVAL_STATUS, summarizeApprovalFlow, type Approval } from '../src/index';

const NOW = new Date('2026-07-31T12:00:00.000Z');

const approval = (over: Partial<Approval> = {}): Approval => ({
  id: 'apr-1',
  requestFingerprint: 'fp-1',
  agentId: 'agent-1',
  action: 'database.migrate',
  approvers: ['alice'],
  minApprovals: 1,
  grants: [],
  status: APPROVAL_STATUS.PENDING,
  createdAt: '2026-07-31T11:00:00.000Z',
  ...over,
});

const resolvedAfter = (minutes: number, id: string): Approval =>
  approval({
    id,
    status: APPROVAL_STATUS.APPROVED,
    createdAt: '2026-07-31T00:00:00.000Z',
    resolvedAt: new Date(
      Date.parse('2026-07-31T00:00:00.000Z') + minutes * 60_000,
    ).toISOString(),
    resolvedBy: 'alice',
    grants: [{ by: 'alice', at: '2026-07-31T00:10:00.000Z' }],
  });

describe('summarizeApprovalFlow', () => {
  it('counts nothing without inventing a resolve time', () => {
    const summary = summarizeApprovalFlow([], NOW);

    expect(summary.total).toBe(0);
    expect(summary.medianResolveMinutes).toBeNull();
    expect(summary.p90ResolveMinutes).toBeNull();
    expect(summary.oldestPendingMinutes).toBeNull();
  });

  it('reports median and p90 time to resolve', () => {
    const summary = summarizeApprovalFlow(
      [
        resolvedAfter(10, 'a'),
        resolvedAfter(20, 'b'),
        resolvedAfter(30, 'c'),
        resolvedAfter(600, 'd'),
      ],
      NOW,
    );

    expect(summary.approved).toBe(4);
    expect(summary.medianResolveMinutes).toBe(20);
    expect(summary.p90ResolveMinutes).toBe(600);
  });

  it('counts a pending approval past its TTL as lapsed, not pending', () => {
    const summary = summarizeApprovalFlow(
      [
        approval({ id: 'fresh', expiresAt: '2026-08-07T00:00:00.000Z' }),
        approval({ id: 'stale', expiresAt: '2026-07-24T00:00:00.000Z' }),
      ],
      NOW,
    );

    expect(summary.pending).toBe(1);
    expect(summary.lapsed).toBe(1);
  });

  it('counts an already-swept expired record as lapsed too', () => {
    const summary = summarizeApprovalFlow(
      [approval({ status: APPROVAL_STATUS.EXPIRED })],
      NOW,
    );

    expect(summary.lapsed).toBe(1);
    expect(summary.pending).toBe(0);
  });

  it('measures the oldest unresolved approval against the passed-in clock', () => {
    const summary = summarizeApprovalFlow(
      [
        approval({ id: 'recent', createdAt: '2026-07-31T11:30:00.000Z' }),
        approval({ id: 'old', createdAt: '2026-07-31T09:00:00.000Z' }),
      ],
      NOW,
    );

    expect(summary.oldestPendingMinutes).toBe(180);
  });

  it('counts a break-glass override once and tallies grants per approver', () => {
    const summary = summarizeApprovalFlow(
      [
        resolvedAfter(5, 'a'),
        approval({
          id: 'forced',
          status: APPROVAL_STATUS.APPROVED,
          override: true,
          resolvedAt: '2026-07-31T11:30:00.000Z',
          grants: [{ by: 'bob', at: '2026-07-31T11:29:00.000Z' }],
        }),
      ],
      NOW,
    );

    expect(summary.overrides).toBe(1);
    expect(summary.approverActivity).toEqual([
      { approver: 'alice', grants: 1 },
      { approver: 'bob', grants: 1 },
    ]);
  });

  it('is reproducible: the same records and clock give the same summary', () => {
    const records = [approval({ expiresAt: '2026-07-24T00:00:00.000Z' })];

    expect(summarizeApprovalFlow(records, NOW)).toEqual(
      summarizeApprovalFlow(records, NOW),
    );
  });
});
