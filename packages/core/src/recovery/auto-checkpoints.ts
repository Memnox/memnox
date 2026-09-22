/**
 * Milestones a seam keeps without being asked, for agents nobody started under
 * `memnox run`. The marks are read before git is, so a hook that owes nothing
 * starts no process at all.
 */
import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { MEMNOX_HOME } from '../config/config';
import { readJsonArray, writeJsonFile } from '../store/json-records';
import {
  checkpointDue,
  DESTRUCTIVE_SPACING_MS,
  markTaken,
  type CheckpointMark,
  type CheckpointRequest,
} from './checkpoint';
import { MILESTONE_KEEP, type Milestone } from './milestone';
import { Milestones } from './milestones';
import { NodeGit, NodeWorktree } from './node-git';
import type { GitPort } from './ports';

export const CHECKPOINT_MARKS_FILE = 'checkpoints.json';

export interface CheckpointMarkStore {
  read(): Promise<CheckpointMark[]>;
  write(marks: readonly CheckpointMark[]): Promise<void>;
}

/** Under the Memnox home rather than `.git`, so a worktree or a bare clone reads the same. */
export class FileCheckpointMarks implements CheckpointMarkStore {
  private readonly path: string;

  constructor(home: string) {
    this.path = join(home, MEMNOX_HOME, CHECKPOINT_MARKS_FILE);
  }

  read(): Promise<CheckpointMark[]> {
    return readJsonArray<CheckpointMark>(this.path);
  }

  write(marks: readonly CheckpointMark[]): Promise<void> {
    return writeJsonFile(this.path, marks);
  }
}

export interface AutoCheckpointDeps {
  marks: CheckpointMarkStore;
  /** git in the place the session works, which is where the repository is found from. */
  gitAt?: (place: string) => GitPort;
  keep?: number;
  spacingMs?: number;
}

function realGitAt(place: string): GitPort {
  return new NodeGit(place);
}

/** The path with its links followed, as git reports the root, or as given where it is not there. */
function real(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    // Not there yet, or already gone: the spelling given is the best there is.
    return path;
  }
}

/** Whether a path a command names falls inside the repository the milestone is of. */
function inside(root: string, place: string, operand: string): boolean {
  // `~` is expanded by a shell that has not run yet, so it is somewhere else.
  if (operand.startsWith('~')) return false;
  const path = relative(real(root), real(resolve(real(place), operand)));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

export class AutoCheckpoints {
  constructor(private readonly deps: AutoCheckpointDeps) {}

  /**
   * A milestone when this request earns one, or null. `operands` narrows a command that
   * names files to the ones inside the repository, since deleting `/tmp` risks nothing here.
   */
  async before(
    request: CheckpointRequest,
    operands: readonly string[] = [],
  ): Promise<Milestone | null> {
    const marks = await this.deps.marks.read();
    const spacing = this.deps.spacingMs ?? DESTRUCTIVE_SPACING_MS;
    if (!checkpointDue(marks, request, spacing)) return null;

    const git = (this.deps.gitAt ?? realGitAt)(request.place);
    const root = await git.root();
    if (root === null) return null;
    const named = operands.filter((operand) => inside(root, request.place, operand));
    if (operands.length > 0 && named.length === 0) return null;

    // Marked before git runs, so two hooks racing on one session keep one tree and not two.
    await this.deps.marks.write(markTaken(marks, request));
    const milestones = new Milestones(git, new NodeWorktree(root));
    const taken = await milestones.take({
      at: request.at,
      reason: request.kind,
      sessionId: request.sessionId,
      agent: request.agent,
      ...(request.note === undefined ? {} : { note: request.note }),
    });
    // Retention runs where milestones are made, so a busy machine never piles up refs.
    await milestones.forget(this.deps.keep ?? MILESTONE_KEEP);
    return taken;
  }
}
