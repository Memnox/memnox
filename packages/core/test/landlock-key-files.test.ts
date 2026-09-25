import { describe, expect, it } from 'vitest';
import { untrustedLandlockPlan, type CarveEntry } from '../src/intercept/untrusted-guard';

const KEYS = ['.', 'env'].join('');

const TREE: Readonly<Record<string, readonly string[]>> = {
  '/': ['w', 'usr'],
  '/w': [KEYS, `${KEYS}.example`, 'src', 'node_modules'],
  '/w/src': ['app.ts', `${KEYS}.local`],
  '/home/dev': [],
};

function list(dir: string): readonly CarveEntry[] {
  return (TREE[dir] ?? []).map((name) => ({ name, symlink: false }));
}

describe('the Linux wall of an untrusted repository', () => {
  const plan = untrustedLandlockPlan(
    {
      home: '/home/dev',
      writable: ['/w'],
      readable: [],
      unreadable: [],
      unwritable: [],
      statePrefixes: [],
      proxyPort: null,
      workspace: '/w',
    },
    list,
  );

  it('grants neither reading nor writing of its key files', () => {
    for (const denied of [`/w/${KEYS}`, `/w/src/${KEYS}.local`]) {
      expect(plan.read).not.toContain(denied);
      expect(plan.write).not.toContain(denied);
    }
  });

  it('grants the rest, the template of names included', () => {
    expect(plan.read).toContain(`/w/${KEYS}.example`);
    expect(plan.read).toContain('/w/src/app.ts');
    expect(plan.write).toContain('/w/node_modules');
  });
});
