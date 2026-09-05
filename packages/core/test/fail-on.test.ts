import { describe, expect, it } from 'vitest';
import { changesFailing, failOnValues, isFailOn, FAIL_ON } from '../src/discovery/fail-on';
import type { EnvironmentChange } from '../src/discovery/snapshot';

const change = (over: Partial<EnvironmentChange>): EnvironmentChange =>
  ({
    subject: 'tool',
    name: 'x',
    direction: 'widens',
    detail: '',
    ...over,
  }) as EnvironmentChange;

const WIDENED_WRITE = change({ subject: 'tool', name: 'create_pr', detail: 'write tool added' });
const WIDENED_READ = change({ subject: 'tool', name: 'get_issue', detail: 'read tool added' });
const NEW_CREDENTIAL = change({
  subject: 'resource',
  name: 'AWS_SECRET_ACCESS_KEY',
  detail: 'secret newly reachable',
});
const REMOVED_SERVER = change({
  subject: 'server',
  name: 'stripe',
  direction: 'narrows',
  detail: 'server removed',
});

describe('--fail-on', () => {
  it('names the gates it accepts, and refuses anything else', () => {
    expect(failOnValues()).toEqual(['any', 'write-capable', 'credential']);
    expect(isFailOn('credential')).toBe(true);
    expect(isFailOn('sometimes')).toBe(false);
  });

  it('never fails on a narrowing, or the team stops running the build', () => {
    for (const gate of failOnValues()) {
      expect(changesFailing([REMOVED_SERVER], gate)).toEqual([]);
    }
  });

  it('fails on anything that widened, under "any"', () => {
    const failing = changesFailing(
      [WIDENED_READ, WIDENED_WRITE, NEW_CREDENTIAL, REMOVED_SERVER],
      FAIL_ON.ANY,
    );
    expect(failing).toHaveLength(3);
  });

  it('ignores a new read tool under "write-capable"', () => {
    const failing = changesFailing([WIDENED_READ, WIDENED_WRITE], FAIL_ON.WRITE_CAPABLE);
    expect(failing.map((each) => each.name)).toEqual(['create_pr']);
  });

  it('catches a credential that became visible, under "credential"', () => {
    const failing = changesFailing(
      [WIDENED_WRITE, NEW_CREDENTIAL],
      FAIL_ON.CREDENTIAL,
    );
    expect(failing.map((each) => each.name)).toEqual(['AWS_SECRET_ACCESS_KEY']);
  });

  it('returns the changes rather than a count, so CI can print why it failed', () => {
    const [first] = changesFailing([NEW_CREDENTIAL], FAIL_ON.ANY);
    expect(first?.detail).toContain('secret');
  });
});
