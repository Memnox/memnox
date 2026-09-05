import {
  decodeMessage,
  encodeMessage,
  idFromRef,
  milestoneIdFor,
  MILESTONE_KEEP,
  MILESTONE_REASON,
  MILESTONE_REF_PREFIX,
  milestonesToForget,
  refFor,
  type Milestone,
  type MilestoneReason,
} from './milestone';
import { REWIND_REFUSAL, RewindRefused, type GitPort, type WorktreePort } from './ports';

/**
 * Taking and restoring working trees. Every git call here is read-only or writes into
 * `refs/memnox/` — with exactly one exception, the restore, which is the whole point and
 * is guarded by taking a milestone of what it is about to replace.
 */

/** A scratch index, so `git add -A` never touches the one the person is staging into. */
const SCRATCH_INDEX = '.git/memnox-index';

const IN_PROGRESS: readonly [string, string][] = [
  ['MERGE_HEAD', 'a merge'],
  ['REBASE_HEAD', 'a rebase'],
  ['rebase-merge', 'a rebase'],
  ['rebase-apply', 'a rebase'],
  ['CHERRY_PICK_HEAD', 'a cherry-pick'],
  ['REVERT_HEAD', 'a revert'],
  ['BISECT_LOG', 'a bisect'],
];

export interface TakeMilestone {
  at: string;
  reason?: MilestoneReason;
  sessionId?: string;
  note?: string;
}

export class Milestones {
  constructor(
    private readonly git: GitPort,
    private readonly tree: WorktreePort,
  ) {}

  /**
   * The working tree as it is right now, including files git has never seen but not the
   * ones it is told to ignore — restoring somebody's `node_modules` from a tree object
   * would take a minute and help nobody.
   */
  async take(request: TakeMilestone): Promise<Milestone> {
    const root = await this.repositoryRoot();
    const env = { GIT_INDEX_FILE: `${root}/${SCRATCH_INDEX}` };

    // Seed from HEAD so the tree is a delta and not a fresh copy of the repository.
    await this.git.run(['read-tree', 'HEAD'], env).catch(async () => {
      // A repository with no commits yet has no HEAD to read; start from nothing.
      await this.git.run(['read-tree', '--empty'], env);
    });
    await this.git.run(['add', '-A', '--', '.'], env);
    const tree = await this.git.run(['write-tree'], env);
    const files = (await this.git.run(['ls-files', '--', '.'], env))
      .split('\n')
      .filter((line) => line !== '').length;

    const message = encodeMessage({
      takenAt: request.at,
      reason: request.reason ?? MILESTONE_REASON.MANUAL,
      files,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      ...(request.note === undefined ? {} : { note: request.note }),
    });
    const parent = await this.head();
    const commit = await this.git.run([
      'commit-tree',
      tree,
      ...(parent === null ? [] : ['-p', parent]),
      '-m',
      message,
    ]);

    const id = milestoneIdFor(request.at, commit);
    await this.git.run(['update-ref', refFor(id), commit]);
    return {
      id,
      commit,
      takenAt: request.at,
      reason: request.reason ?? MILESTONE_REASON.MANUAL,
      files,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      ...(request.note === undefined ? {} : { note: request.note }),
    };
  }

  async list(): Promise<Milestone[]> {
    // Checked first: a raw "fatal: not a git repository" is not an answer to "rewind".
    await this.repositoryRoot();
    const listing = await this.git.run([
      'for-each-ref',
      '--format=%(refname)%09%(objectname)%09%(contents)',
      MILESTONE_REF_PREFIX,
    ]);
    const found: Milestone[] = [];
    // A ref's own body can hold newlines, so records are split on the ref prefix.
    for (const chunk of listing.split(`${MILESTONE_REF_PREFIX}/`)) {
      if (chunk.trim() === '') continue;
      const [head, ...body] = `${MILESTONE_REF_PREFIX}/${chunk}`.split('\t');
      const id = idFromRef((head ?? '').trim());
      const commit = (body[0] ?? '').trim();
      if (id === null || commit === '') continue;
      const decoded = decodeMessage(body.slice(1).join('\t'));
      if (decoded === null) continue;
      found.push({ id, commit, ...decoded });
    }
    return found.sort((a, b) => b.takenAt.localeCompare(a.takenAt));
  }

  async latest(): Promise<Milestone | null> {
    return (await this.list())[0] ?? null;
  }

  /**
   * The working tree, put back. It writes every file the milestone held and deletes the
   * ones that arrived after it — and it takes a milestone of the current state first,
   * because a rewind that cannot be undone is a second way to lose work.
   */
  async restore(
    id: string,
    at: string,
  ): Promise<{ restored: Milestone; kept: Milestone }> {
    const root = await this.repositoryRoot();
    await this.refuseIfMidOperation(root);

    const milestones = await this.list();
    const target = milestones.find((milestone) => milestone.id === id);
    if (target === undefined) {
      throw new RewindRefused(
        REWIND_REFUSAL.UNKNOWN_MILESTONE,
        `No milestone ${id}. "memnox rewind --list" shows the ones there are.`,
      );
    }

    const kept = await this.take({
      at,
      reason: MILESTONE_REASON.REPLACED,
      note: `what ${target.id} replaced`,
    });

    const env = { GIT_INDEX_FILE: `${root}/${SCRATCH_INDEX}` };
    /* Anything present now and absent from the milestone was created after it, so it is
       what the agent added. Computed before the checkout, which would blur the two. */
    const added = (
      await this.git.run([
        'diff',
        '--name-only',
        '--diff-filter=A',
        `${target.commit}`,
        `${kept.commit}`,
      ])
    )
      .split('\n')
      .filter((line) => line !== '');

    await this.git.run(['read-tree', target.commit], env);
    await this.git.run(['checkout-index', '-a', '-f'], env);
    /* Unlinked rather than `git rm`: a file the agent created is untracked in the
       person's own index, which is exactly the index `git rm` would consult. */
    for (const path of added) await this.tree.remove(`${root}/${path}`);
    // The person's own index is left exactly as it was; only the files moved.
    return { restored: target, kept };
  }

  async forget(keep: number = MILESTONE_KEEP): Promise<string[]> {
    const dropped = milestonesToForget(await this.list(), keep);
    for (const milestone of dropped) {
      await this.git.run(['update-ref', '-d', refFor(milestone.id)]);
    }
    return dropped.map((milestone) => milestone.id);
  }

  private async head(): Promise<string | null> {
    try {
      return await this.git.run(['rev-parse', 'HEAD']);
    } catch {
      // No commits yet. The milestone is simply parentless.
      return null;
    }
  }

  private async repositoryRoot(): Promise<string> {
    const root = await this.git.root();
    if (root === null) {
      throw new RewindRefused(
        REWIND_REFUSAL.NOT_A_REPO,
        'Not a git repository, so there is no working tree to keep.',
      );
    }
    return root;
  }

  /**
   * Mid-merge, the state that says how to finish lives in files a restore would write
   * over. Refusing is the only honest answer: finishing or aborting is the person's call.
   */
  private async refuseIfMidOperation(root: string): Promise<void> {
    for (const [marker, what] of IN_PROGRESS) {
      if (await this.tree.exists(`${root}/.git/${marker}`)) {
        throw new RewindRefused(
          REWIND_REFUSAL.MID_OPERATION,
          `${what} is in progress here. Finish or abort it first — a rewind would write over the state that says how.`,
        );
      }
    }
  }
}
