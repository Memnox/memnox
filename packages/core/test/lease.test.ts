import { describe, expect, it } from 'vitest';
import {
  conflicts,
  DEFAULT_LEASE_MINUTES,
  describeLease,
  LEASE_MAX_ACTIVITY,
  LEASE_MAX_WAIT_MS,
  LEASE_STATE,
  leaseFor,
  leaseState,
  leasesInForce,
  MAX_LEASE_MINUTES,
  normalizeLeasePath,
  sameHolder,
  waitFor,
  withActivity,
  type Lease,
  type LeaseHolder,
} from '../src/coordination/lease';
import { leasePathFor, leaseScopeFor, takesLease } from '../src/coordination/writes';
import { TOOL_CLASS } from '../src/discovery/classify';
import { COMMAND_CLASS } from '../src/intercept/binary-class';

const NOW = '2026-09-05T10:00:00.000Z';
const at = (minutes: number): string =>
  new Date(Date.parse(NOW) + minutes * 60_000).toISOString();

const holder: LeaseHolder = { agent: 'cursor', sessionId: 'ses_1', pid: 4242 };
const other: LeaseHolder = { agent: 'claude-code', sessionId: 'ses_2', pid: 909 };
const living = (): boolean => true;
const dead = (): boolean => false;

describe('the overlap rule locks paths and nothing else', () => {
  it('holds a file inside the directory it took', () => {
    expect(conflicts('src/billing', 'src/billing/invoice.ts')).toBe(true);
  });

  it('does not hold a sibling that merely starts the same way', () => {
    expect(conflicts('src/billing', 'src/billing-legacy')).toBe(false);
    expect(conflicts('src/billing', 'src/billing-legacy/old.ts')).toBe(false);
  });

  it('collides in both directions, because the second writer may be broader', () => {
    expect(conflicts('src/billing/invoice.ts', 'src/billing')).toBe(true);
  });

  it('lets the root hold everything, which is what a whole-tree refactor takes', () => {
    expect(conflicts('', 'src/billing/invoice.ts')).toBe(true);
  });

  it('leaves unrelated directories alone', () => {
    expect(conflicts('src/billing', 'src/auth')).toBe(false);
  });
});

describe('one spelling per path', () => {
  it('strips the noise two agents would otherwise disagree about', () => {
    expect(normalizeLeasePath('./src//billing/')).toBe('src/billing');
    expect(normalizeLeasePath('src\\billing')).toBe('src/billing');
  });

  it('reads an empty path as the repository root rather than as nothing', () => {
    expect(normalizeLeasePath('.')).toBe('');
  });

  it('refuses a path that walks out of the tree, rather than guessing', () => {
    expect(normalizeLeasePath('../other-repo/src')).toBeNull();
  });
});

describe('a lease that cannot expire is a lease nobody turns on', () => {
  it('always carries an expiry', () => {
    expect(leaseFor('src', holder, NOW).expiresAt).toBe(at(DEFAULT_LEASE_MINUTES));
  });

  it('clamps a day down to the ceiling instead of failing the call', () => {
    expect(leaseFor('src', holder, NOW, 60 * 24).expiresAt).toBe(at(MAX_LEASE_MINUTES));
  });

  it('is expired once the moment reaches it, and is no longer in force', () => {
    const lease = leaseFor('src', holder, NOW, 30);
    expect(leaseState(lease, at(31), living)).toBe(LEASE_STATE.EXPIRED);
    expect(leasesInForce([lease], at(31), living)).toEqual([]);
  });
});

describe('a dead owner is reclaimed rather than waited on', () => {
  it('reads as abandoned when the process is gone', () => {
    const lease = leaseFor('src', holder, NOW);
    expect(leaseState(lease, at(1), dead)).toBe(LEASE_STATE.ABANDONED);
    expect(leasesInForce([lease], at(1), dead)).toEqual([]);
  });

  it('is still held while the process lives', () => {
    expect(leaseState(leaseFor('src', holder, NOW), at(1), living)).toBe(
      LEASE_STATE.HELD,
    );
  });
});

describe('release and takeover leave a record', () => {
  it('stops being in force once released', () => {
    const lease: Lease = { ...leaseFor('src', holder, NOW), releasedAt: at(2) };
    expect(leaseState(lease, at(3), living)).toBe(LEASE_STATE.RELEASED);
  });

  it('reads as taken over even before it would have expired', () => {
    const lease: Lease = {
      ...leaseFor('src', holder, NOW),
      takenOver: { by: other, at: at(2), reason: 'the build is broken' },
    };
    expect(leaseState(lease, at(3), living)).toBe(LEASE_STATE.TAKEN_OVER);
  });
});

describe('the same session never waits on itself', () => {
  it('recognises its own holder across a lost lease id', () => {
    expect(sameHolder(holder, { ...holder, pid: 5 })).toBe(true);
  });

  it('tells two sessions of the same agent apart', () => {
    expect(sameHolder(holder, { ...holder, sessionId: 'ses_other' })).toBe(false);
  });
});

describe('a wait is always bounded', () => {
  it('never waits past the ceiling, however long the lease has left', () => {
    expect(waitFor(leaseFor('src', holder, NOW, 240), NOW)).toBe(LEASE_MAX_WAIT_MS);
  });

  it('never waits past the lease that is in the way', () => {
    expect(waitFor(leaseFor('src', holder, NOW, 240), at(239))).toBe(60_000);
  });

  it('does not wait at all on one that has already expired', () => {
    expect(waitFor(leaseFor('src', holder, NOW, 10), at(20))).toBe(0);
  });
});

describe('what the holder has been doing', () => {
  it('keeps the newest and drops the oldest, so one session cannot grow the file', () => {
    let lease = leaseFor('src', holder, NOW);
    for (let i = 0; i < LEASE_MAX_ACTIVITY + 5; i += 1) {
      lease = withActivity(lease, `wrote file-${i}.ts`);
    }
    expect(lease.activity).toHaveLength(LEASE_MAX_ACTIVITY);
    expect(lease.activity.at(-1)).toBe(`wrote file-${LEASE_MAX_ACTIVITY + 4}.ts`);
  });

  it('ignores an empty note rather than recording a blank line', () => {
    expect(withActivity(leaseFor('src', holder, NOW), '  ').activity).toEqual([]);
  });

  it('names the holder, the path and how long, which is what a refusal needs', () => {
    const line = describeLease(leaseFor('src/billing', holder, NOW), at(12));
    expect(line).toContain('cursor');
    expect(line).toContain('src/billing');
    expect(line).toContain('12 min');
  });

  it('calls the root by a name a person would recognise', () => {
    expect(describeLease(leaseFor('', holder, NOW), at(1))).toContain(
      'the repository root',
    );
  });
});

describe('a read never waits', () => {
  it('takes no lease for a read, whatever surface named it', () => {
    expect(takesLease(TOOL_CLASS.READ)).toBe(false);
    expect(takesLease(COMMAND_CLASS.NORMAL)).toBe(false);
    expect(takesLease(COMMAND_CLASS.NETWORK)).toBe(false);
    expect(takesLease(TOOL_CLASS.UNKNOWN)).toBe(false);
  });

  it('takes one for write-class and destructive work, in either vocabulary', () => {
    expect(takesLease(TOOL_CLASS.WRITE)).toBe(true);
    expect(takesLease(TOOL_CLASS.DESTRUCTIVE)).toBe(true);
    expect(takesLease(COMMAND_CLASS.DESTRUCTIVE)).toBe(true);
    expect(takesLease(COMMAND_CLASS.PACKAGE_INSTALL)).toBe(true);
  });
});

describe('the path a command would take a lease on', () => {
  const root = '/work/repo';

  it('resolves a relative target against the working directory', () => {
    expect(leasePathFor('src/billing', root, '/work/repo')).toBe('src/billing');
    expect(leasePathFor('billing/invoice.ts', root, '/work/repo/src')).toBe(
      'src/billing/invoice.ts',
    );
  });

  it('takes an absolute path inside the repository', () => {
    expect(leasePathFor('/work/repo/src/auth.ts', root, root)).toBe('src/auth.ts');
  });

  it('declines anything outside the repository rather than approximating one', () => {
    expect(leasePathFor('/etc/hosts', root, root)).toBeNull();
    expect(leasePathFor('../elsewhere/file.ts', root, root)).toBeNull();
  });

  it('declines a target that is a host and not a path at all', () => {
    expect(leasePathFor('https://example.com/x', root, root)).toBeNull();
    expect(leasePathFor(undefined, root, root)).toBeNull();
  });

  it('reads the repository itself as the root lease', () => {
    expect(leasePathFor('/work/repo', root, root)).toBe('');
  });
});

describe('the scope a write claims', () => {
  const directories = (path: string): boolean => !path.includes('.');

  it('claims the directory a file lands in, so ten files are one lease', () => {
    expect(leaseScopeFor('src/billing/invoice.ts', directories)).toBe('src/billing');
    expect(leaseScopeFor('src/billing/tax.ts', directories)).toBe('src/billing');
  });

  it('claims a directory as itself rather than widening to its parent', () => {
    expect(leaseScopeFor('src/billing', directories)).toBe('src/billing');
  });

  it('asks rather than guessing from a dot in the name', () => {
    expect(leaseScopeFor('src/v1.2', () => true)).toBe('src/v1.2');
    expect(leaseScopeFor('.eslintrc', () => false)).toBe('');
  });

  it('reads a file at the top of the tree as the root', () => {
    expect(leaseScopeFor('README.md', directories)).toBe('');
  });
});
