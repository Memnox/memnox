import { describe, expect, it } from 'vitest';
import {
  carve,
  landlockPlanFromPolicy,
  untrustedLandlockPlan,
  untrustedSeatbeltProfile,
  type CarveEntry,
  type UntrustedGuard,
} from '../src/index';

const TREE: Record<string, CarveEntry[]> = {
  '/': [
    { name: 'usr', symlink: false },
    { name: 'home', symlink: false },
    { name: 'bin', symlink: true },
  ],
  '/home': [{ name: 'dev', symlink: false }],
  '/home/dev': [
    { name: '.ssh', symlink: false },
    { name: '.aws', symlink: false },
    { name: '.claude', symlink: false },
    { name: '.claude.json', symlink: false },
    { name: '.memnox', symlink: false },
    { name: 'shop', symlink: false },
    { name: 'notes', symlink: false },
  ],
  '/home/dev/.memnox': [
    { name: 'memnox.db', symlink: false },
    { name: 'pending', symlink: false },
    { name: 'policies.json', symlink: false },
  ],
};

function list(dir: string): readonly CarveEntry[] {
  return TREE[dir] ?? [];
}

const GUARD: UntrustedGuard = {
  home: '/home/dev',
  writable: ['/home/dev/shop', '/tmp', '/home/dev/.memnox'],
  readable: ['/home/dev/.memnox'],
  unreadable: ['/home/dev/Library/Keychains'],
  unwritable: ['/home/dev/.memnox/pending', '/home/dev/.memnox/policies.json'],
  statePrefixes: ['/home/dev/.claude'],
  proxyPort: 18080,
};

describe('carving a grant around what is denied', () => {
  it('grants every sibling on the way down, and never the denied path or a link', () => {
    expect(carve('/', ['/home/dev/.ssh'], list)).toEqual([
      '/usr',
      '/home/dev/.aws',
      '/home/dev/.claude',
      '/home/dev/.claude.json',
      '/home/dev/.memnox',
      '/home/dev/shop',
      '/home/dev/notes',
    ]);
  });

  it('grants the whole root when nothing under it is denied', () => {
    expect(carve('/usr', ['/home/dev/.ssh'], list)).toEqual(['/usr']);
  });

  it('grants nothing when the root itself is denied', () => {
    expect(carve('/home/dev/.ssh', ['/home/dev/.ssh'], list)).toEqual([]);
  });
});

describe('the untrusted Landlock plan', () => {
  const plan = untrustedLandlockPlan(GUARD, list);

  it('leaves dotfiles unreadable, bar the agent state and the Memnox home', () => {
    expect(plan.read).not.toContain('/home/dev/.ssh');
    expect(plan.read).not.toContain('/home/dev/.aws');
    expect(plan.read).toEqual(
      expect.arrayContaining([
        '/home/dev/.claude',
        '/home/dev/.memnox',
        '/home/dev/shop',
      ]),
    );
  });

  it('writes only to the repository, temp and state, never to the answers of held calls', () => {
    expect(plan.write).toEqual(
      expect.arrayContaining([
        '/home/dev/shop',
        '/tmp',
        '/home/dev/.memnox/memnox.db',
        '/home/dev/.claude',
      ]),
    );
    expect(plan.write).not.toContain('/home/dev/.memnox/pending');
    expect(plan.write).not.toContain('/home/dev/.memnox/policies.json');
    expect(plan.write).not.toContain('/home/dev/notes');
  });

  it('reaches only the egress proxy over TCP', () => {
    expect(plan.connectPorts).toEqual([18080]);
  });

  it('leaves TCP alone for the plan protect wrote', () => {
    const fromPolicy = landlockPlanFromPolicy(
      { denyRead: ['/home/dev/.ssh'], denyWrite: [], allowWrite: [] },
      list,
    );
    expect(fromPolicy.connectPorts).toBeNull();
    expect(fromPolicy.write).not.toContain('/home/dev/.ssh');
  });
});

describe('the untrusted seatbelt profile', () => {
  const profile = untrustedSeatbeltProfile(GUARD);

  it('refuses dotfiles and hands back the named few, the later rule winning', () => {
    const lines = profile.split('\n');
    const refuse = lines.findIndex((line) =>
      line.includes('deny file-read-data (regex #"^/home/dev/\\.'),
    );
    const back = lines.findIndex((line) =>
      line.includes('allow file-read-data (subpath "/home/dev/.memnox")'),
    );
    expect(refuse).toBeGreaterThan(-1);
    expect(back).toBeGreaterThan(refuse);
  });

  it('refuses writes everywhere but the repository, temp and state', () => {
    expect(profile).toContain('(deny file-write*)');
    expect(profile).toContain('(allow file-write* (subpath "/home/dev/shop"))');
    expect(profile).toContain('(allow file-write* (regex #"^/home/dev/\\.claude"))');
    expect(
      profile.indexOf('(deny file-write* (subpath "/home/dev/.memnox/pending"))'),
    ).toBeGreaterThan(
      profile.indexOf('(allow file-write* (subpath "/home/dev/.memnox"))'),
    );
  });

  it('allows TCP to the egress proxy only', () => {
    expect(profile).toContain('(deny network-outbound)');
    expect(profile).toContain('(allow network-outbound (remote ip "localhost:18080"))');
  });
});

describe('toolchains installed under the home', () => {
  const tree: Record<string, CarveEntry[]> = {
    '/': [{ name: 'home', symlink: false }],
    '/home': [{ name: 'dev', symlink: false }],
    '/home/dev': [
      { name: '.cargo', symlink: false },
      { name: '.nvm', symlink: false },
    ],
    '/home/dev/.cargo': [
      { name: 'bin', symlink: false },
      { name: 'credentials.toml', symlink: false },
    ],
  };
  const plan = untrustedLandlockPlan(
    { ...GUARD, readable: ['/home/dev/.nvm', '/home/dev/.cargo/bin'], statePrefixes: [] },
    (dir) => tree[dir] ?? [],
  );

  it('stay readable, down to the one directory named, and no further', () => {
    expect(plan.read).toEqual(
      expect.arrayContaining(['/home/dev/.nvm', '/home/dev/.cargo/bin']),
    );
    expect(plan.read).not.toContain('/home/dev/.cargo/credentials.toml');
    expect(plan.read).not.toContain('/home/dev/.cargo');
  });
});
