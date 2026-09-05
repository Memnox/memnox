import { describe, expect, it } from 'vitest';
import {
  guardFor,
  landlockRuleset,
  OS_GUARD,
  parseKernel,
  sandboxCommand,
  seatbeltProfile,
} from '../src/intercept/os-guard';

const POLICY = {
  denyRead: ['/home/dev/.aws', '/home/dev/.ssh'],
  denyWrite: ['/etc'],
  allowWrite: ['/home/dev/project'],
};

describe('which guard this machine can hold', () => {
  it('uses seatbelt on macOS', () => {
    expect(guardFor('darwin', '23.5.0').guard).toBe(OS_GUARD.SEATBELT);
  });

  it('uses Landlock on a kernel new enough for it', () => {
    expect(guardFor('linux', '6.8.0-generic').guard).toBe(OS_GUARD.LANDLOCK);
    expect(guardFor('linux', '5.13.0').guard).toBe(OS_GUARD.LANDLOCK);
  });

  it('says plainly when a kernel is too old, rather than pretending to protect', () => {
    const support = guardFor('linux', '5.4.0');
    expect(support.guard).toBe(OS_GUARD.NONE);
    expect(support.because).toContain('needs 5.13+');
    expect(support.because).toContain('only gate');
  });

  it('reports none on a platform with neither, naming what is left', () => {
    expect(guardFor('win32', '10.0.0').because).toContain('only gate');
  });

  it('reads a kernel version, and refuses to guess at one it cannot', () => {
    expect(parseKernel('6.8.0-76-generic')).toEqual({ major: 6, minor: 8 });
    expect(parseKernel('unknown')).toBeNull();
    expect(guardFor('linux', 'unknown').guard).toBe(OS_GUARD.NONE);
  });
});

describe('the seatbelt profile', () => {
  const profile = seatbeltProfile(POLICY);

  it('denies every path the rules deny', () => {
    expect(profile).toContain('(deny file-read* (subpath "/home/dev/.aws"))');
    expect(profile).toContain('(deny file-read* (subpath "/home/dev/.ssh"))');
    expect(profile).toContain('(deny file-write* (subpath "/etc"))');
  });

  it('still allows the directory the work happens in', () => {
    expect(profile).toContain('(allow file-write* (subpath "/home/dev/project"))');
  });

  it('is allow-by-default, because a deny-by-default profile breaks the first build', () => {
    expect(profile).toContain('(allow default)');
  });

  it('says it is generated, so nobody hand-edits it and loses the edit', () => {
    expect(profile).toContain('Regenerate rather than edit');
  });

  it('wraps the command for sandbox-exec', () => {
    expect(sandboxCommand('/tmp/p.sb', ['claude', '--foo'])).toEqual([
      'sandbox-exec',
      '-f',
      '/tmp/p.sb',
      'claude',
      '--foo',
    ]);
  });
});

describe('the Landlock ruleset', () => {
  const ruleset = landlockRuleset(POLICY);

  it('handles both read and write access, or a denial is only half a wall', () => {
    expect(ruleset.handledAccess).toContain('read_file');
    expect(ruleset.handledAccess).toContain('write_file');
    expect(ruleset.handledAccess).toContain('remove_file');
  });

  it('grants the work directory and never the denied ones', () => {
    const granted = ruleset.rules.filter((rule) => rule.allow.length > 0);
    expect(granted.map((rule) => rule.path)).toEqual(['/home/dev/project']);
    expect(granted.flatMap((rule) => rule.allow)).toContain('write_file');
  });

  it('names the denied paths with no access at all', () => {
    const denied = ruleset.rules.filter((rule) => rule.allow.length === 0);
    expect(denied.map((rule) => rule.path)).toEqual(['/home/dev/.aws', '/home/dev/.ssh']);
  });
});
