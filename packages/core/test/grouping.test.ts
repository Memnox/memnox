import { describe, expect, it } from 'vitest';
import {
  describeGroup,
  groupDetail,
  groupPending,
  targetFamily,
} from '../src/gate/grouping';
import type { PendingApproval } from '../src/gate/pending';

const NOW = '2026-09-05T10:00:00.000Z';

const pending = (
  id: string,
  operation: string,
  target?: string,
  agent = 'claude-code',
): PendingApproval => ({
  id,
  askedAt: NOW,
  expiresAt: '2026-09-05T10:02:00.000Z',
  request: {
    sessionId: 'ses_1',
    agent,
    operation,
    fingerprint: id,
    reason: 'held',
    ...(target === undefined ? {} : { target }),
  },
});

describe('what makes two calls the same kind of work', () => {
  it('treats files in one directory as one decision', () => {
    expect(targetFamily('src/checkout/cart.ts')).toBe('src/checkout');
    expect(targetFamily('src/checkout/tax.ts')).toBe('src/checkout');
  });

  /* A host, a branch and a table are not usefully generalised, and pretending
     otherwise would group calls a person did not mean to answer together. */
  it('leaves anything without a path standing for itself', () => {
    expect(targetFamily('api.stripe.com')).toBe('api.stripe.com');
    expect(targetFamily(undefined)).toBe('');
  });
});

describe('grouping', () => {
  it('folds identical work in one place into a single question', () => {
    const groups = groupPending([
      pending('a', 'filesystem.write', 'src/checkout/cart.ts'),
      pending('b', 'filesystem.write', 'src/checkout/tax.ts'),
      pending('c', 'filesystem.write', 'src/checkout/fees.ts'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members).toHaveLength(3);
    expect(describeGroup(groups[0]!)).toContain('3 calls');
  });

  it('keeps different operations apart', () => {
    const groups = groupPending([
      pending('a', 'filesystem.write', 'src/checkout/cart.ts'),
      pending('b', 'filesystem.delete', 'src/checkout/old.ts'),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('keeps different agents apart, because they are different principals', () => {
    const groups = groupPending([
      pending('a', 'filesystem.write', 'src/x/a.ts', 'claude-code'),
      pending('b', 'filesystem.write', 'src/x/b.ts', 'cursor'),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('keeps different directories apart', () => {
    const groups = groupPending([
      pending('a', 'filesystem.write', 'src/checkout/a.ts'),
      pending('b', 'filesystem.write', 'src/auth/b.ts'),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('puts the biggest group first, so one answer clears the most', () => {
    const groups = groupPending([
      pending('a', 'one.thing', 'src/a/x.ts'),
      pending('b', 'two.thing', 'src/b/x.ts'),
      pending('c', 'two.thing', 'src/b/y.ts'),
    ]);
    expect(groups[0]?.operation).toBe('two.thing');
  });

  it('renders a group of one as an ordinary question', () => {
    const [group] = groupPending([pending('a', 'git.push', 'main')]);
    expect(describeGroup(group!)).toContain('1 call');
    expect(describeGroup(group!)).toContain('on main');
  });
});

describe('what a person is agreeing to', () => {
  it('spells out the targets, so nothing is answered blind', () => {
    const [group] = groupPending([
      pending('a', 'filesystem.write', 'src/x/a.ts'),
      pending('b', 'filesystem.write', 'src/x/b.ts'),
    ]);
    expect(groupDetail(group!)).toEqual(['  src/x/a.ts', '  src/x/b.ts']);
  });

  /* A decision covering forty calls is one somebody has to be able to read; a wall of
     paths is the same as showing nothing at all. */
  it('caps the list rather than printing a wall', () => {
    const many = Array.from({ length: 12 }, (_unused, i) =>
      pending(`p${i}`, 'filesystem.write', `src/x/file-${i}.ts`),
    );
    const [group] = groupPending(many);
    const detail = groupDetail(group!);
    expect(detail).toHaveLength(6);
    expect(detail.at(-1)).toContain('7 more');
  });
});
