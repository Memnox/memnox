import { describe, expect, it } from 'vitest';
import { Milestones } from '../src/recovery/milestones';
import { MILESTONE_REASON } from '../src/recovery/milestone';
import {
  REWIND_REFUSAL,
  RewindRefused,
  type GitPort,
  type WorktreePort,
} from '../src/recovery/ports';

/** Answers what it was told to and records every argv, so the git calls are the assertion. */
class FakeGit implements GitPort {
  readonly calls: string[][] = [];
  constructor(
    private readonly answers: Record<string, string> = {},
    private readonly repoRoot: string | null = '/repo',
  ) {}
  async run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    const key = args.slice(0, 2).join(' ');
    return this.answers[key] ?? this.answers[args[0] ?? ''] ?? '';
  }
  async root(): Promise<string | null> {
    return this.repoRoot;
  }
}

class FakeTree implements WorktreePort {
  readonly removed: string[] = [];
  constructor(private readonly present: Set<string> = new Set()) {}
  async exists(path: string): Promise<boolean> {
    return this.present.has(path);
  }
  async remove(path: string): Promise<void> {
    this.removed.push(path);
  }
}

const AT = '2026-09-05T10:00:00.000Z';

describe('taking a milestone', () => {
  /* The person's index is what they are staging into. Writing our own tree through it
     would silently restage their work, which is a data loss bug wearing a feature. */
  it('never writes through the index somebody is staging into', async () => {
    const git = new FakeGit({
      'write-tree': 'tree1',
      'commit-tree': 'commit1',
      'rev-parse': 'head1',
    });

    await new Milestones(git, new FakeTree()).take({ at: AT });

    const add = git.calls.find((call) => call[0] === 'add');
    expect(add).toBeDefined();
    expect(git.calls.some((call) => call[0] === 'stash')).toBe(false);
    expect(git.calls.some((call) => call[0] === 'commit')).toBe(false);
  });

  it('parks the milestone under refs/memnox, not on a branch', async () => {
    const git = new FakeGit({
      'write-tree': 'tree1',
      'commit-tree': 'commit1',
      'rev-parse': 'head1',
    });

    const taken = await new Milestones(git, new FakeTree()).take({ at: AT });

    const update = git.calls.find((call) => call[0] === 'update-ref');
    expect(update?.[1]).toBe(`refs/memnox/milestones/${taken.id}`);
  });

  // A repository with no commits has no HEAD to read; the milestone is simply parentless.
  it('works in a repository that has never been committed to', async () => {
    const git = new FakeGit({ 'write-tree': 'tree1', 'commit-tree': 'commit1' });
    git.run = async (args): Promise<string> => {
      git.calls.push([...args]);
      if (args[0] === 'rev-parse') throw new Error('no HEAD');
      if (args[0] === 'write-tree') return 'tree1';
      if (args[0] === 'commit-tree') return 'commit1';
      return '';
    };

    await expect(
      new Milestones(git, new FakeTree()).take({ at: AT }),
    ).resolves.toBeDefined();
  });

  it('refuses outside a repository, in words rather than a git error', async () => {
    const git = new FakeGit({}, null);

    await expect(new Milestones(git, new FakeTree()).take({ at: AT })).rejects.toThrow(
      RewindRefused,
    );
  });
});

describe('restoring one', () => {
  function ready(): { git: FakeGit; tree: FakeTree } {
    const git = new FakeGit({
      'write-tree': 'tree2',
      'commit-tree': 'commit2',
      'rev-parse': 'head1',
      'for-each-ref': `refs/memnox/milestones/mst_a\tcommitA\tmemnox-milestone ${AT}\n\nreason: session\nfiles: 3\n`,
      'diff --name-only': 'src/invented.ts\n',
    });
    return { git, tree: new FakeTree() };
  }

  /* A rewind that cannot be undone is a second way to lose work, so what it replaces is
     kept before anything is written. */
  it('keeps what it is about to replace', async () => {
    const { git, tree } = ready();

    const { kept } = await new Milestones(git, tree).restore('mst_a', AT);

    expect(kept.reason).toBe(MILESTONE_REASON.REPLACED);
  });

  /* A file the agent created is untracked in the person's own index, which is exactly
     the index `git rm` consults — so it would survive the rewind that removed it. */
  it('unlinks what arrived after the milestone rather than asking git to', async () => {
    const { git, tree } = ready();

    await new Milestones(git, tree).restore('mst_a', AT);

    expect(tree.removed).toEqual(['/repo/src/invented.ts']);
    expect(git.calls.some((call) => call[0] === 'rm')).toBe(false);
  });

  it('writes the tree back through the scratch index', async () => {
    const { git, tree } = ready();

    await new Milestones(git, tree).restore('mst_a', AT);

    expect(git.calls.some((call) => call[0] === 'checkout-index')).toBe(true);
  });

  /* Mid-merge, the state that says how to finish lives in files a restore would write
     over. Refusing is the only honest answer; finishing is the person's call. */
  it('refuses mid-merge, and says which operation', async () => {
    const { git } = ready();
    const tree = new FakeTree(new Set(['/repo/.git/MERGE_HEAD']));

    await expect(new Milestones(git, tree).restore('mst_a', AT)).rejects.toThrow(
      /a merge is in progress/,
    );
  });

  it('refuses a milestone it does not have', async () => {
    const { git, tree } = ready();

    await expect(new Milestones(git, tree).restore('mst_nope', AT)).rejects.toMatchObject(
      {
        refusal: REWIND_REFUSAL.UNKNOWN_MILESTONE,
      },
    );
  });
});
