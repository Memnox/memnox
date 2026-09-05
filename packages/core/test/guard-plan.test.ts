import { describe, expect, it } from 'vitest';
import { guardPathFor, guardPlanFrom, seatbeltProfile } from '../src/intercept/os-guard';

const rule = (
  effect: string,
  actions: string[],
  targets?: string[],
): Parameters<typeof guardPlanFrom>[0][number] => ({
  match: { actions, ...(targets === undefined ? {} : { targets }) },
  decision: { effect },
});

describe('turning a rule into something a kernel takes', () => {
  /* Seatbelt and Landlock take literal subpaths. A rule written as a glob has to be
     resolved or named — a guard that silently covered less than the rules would be
     worse than none, because somebody would stop watching the interceptors. */
  it('resolves the home-anchored globs the generator writes', () => {
    expect(guardPathFor('**/.ssh/**', '/home/me')).toBe('/home/me/.ssh');
    expect(guardPathFor('**/.aws', '/home/me')).toBe('/home/me/.aws');
  });

  it('refuses a pattern with a wildcard the kernel cannot express', () => {
    expect(guardPathFor('**/.env.*', '/home/me')).toBeNull();
    expect(guardPathFor('**/secrets/*/key', '/home/me')).toBeNull();
  });

  it('names what it could not express rather than dropping it', () => {
    const plan = guardPlanFrom(
      [rule('deny', ['filesystem.read'], ['**/.ssh/**', '**/.env.*'])],
      '/home/me',
      ['/work'],
    );

    expect(plan.policy.denyRead).toEqual(['/home/me/.ssh']);
    expect(plan.skipped).toEqual(['**/.env.*']);
  });

  it('takes only denials, because a sandbox has nothing to do with an allow', () => {
    const plan = guardPlanFrom(
      [
        rule('allow', ['filesystem.read'], ['**/.ssh/**']),
        rule('ask', ['filesystem.write'], ['**/.aws/**']),
      ],
      '/home/me',
      ['/work'],
    );

    expect(plan.policy.denyRead).toEqual([]);
    expect(plan.policy.denyWrite).toEqual([]);
  });

  it('ignores a rule that is not about the filesystem at all', () => {
    const plan = guardPlanFrom([rule('deny', ['gh.pr-merge'], ['*'])], '/home/me', []);

    expect(plan.policy.denyRead).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });

  it('writes a profile the denied path actually appears in', () => {
    const plan = guardPlanFrom(
      [rule('deny', ['filesystem.read'], ['**/.ssh/**'])],
      '/home/me',
      ['/work'],
    );

    const profile = seatbeltProfile(plan.policy);
    expect(profile).toContain('(deny file-read* (subpath "/home/me/.ssh"))');
    expect(profile).toContain('(allow file-write* (subpath "/work"))');
  });
});
