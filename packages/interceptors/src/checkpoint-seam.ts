import {
  AutoCheckpoints,
  CHECKPOINT_KIND,
  destructiveCommand,
  destructiveInLine,
  FileCheckpointMarks,
  type CheckpointKind,
  type DestructiveCommand,
  type Milestone,
} from '@memnox/core';

/**
 * The milestones a seam keeps on its own: before a session's first write in a repository
 * and before a command that destroys work. Never a reason to stop the agent, so every
 * failure here is logged and the write or command goes ahead.
 */

/** Who is about to change the tree, and where. */
export interface CheckpointScene {
  home: string;
  sessionId: string;
  agent: string;
  /** The directory the agent works in; the repository is found from it. */
  place: string;
  now: () => Date;
  log: (message: string) => void;
  /** Replaced in tests, so no test needs a real git. */
  checkpoints?: AutoCheckpoints;
}

function checkpointsFor(scene: CheckpointScene): AutoCheckpoints {
  return (
    scene.checkpoints ??
    new AutoCheckpoints({ marks: new FileCheckpointMarks(scene.home) })
  );
}

async function keep(
  scene: CheckpointScene,
  kind: CheckpointKind,
  command?: DestructiveCommand,
): Promise<Milestone | null> {
  try {
    const request = {
      kind,
      sessionId: scene.sessionId,
      agent: scene.agent,
      place: scene.place,
      at: scene.now().toISOString(),
      note:
        command === undefined ? `before ${scene.agent} first wrote here` : command.note,
    };
    return await checkpointsFor(scene).before(request, command?.operands ?? []);
  } catch (err) {
    // A milestone that could not be kept costs a rewind later, never the agent's work now.
    scene.log(`could not keep a milestone: ${String(err)}`);
    return null;
  }
}

/** Once per session per repository, before the editor's first write lands. */
export function checkpointBeforeFirstWrite(
  scene: CheckpointScene,
): Promise<Milestone | null> {
  return keep(scene, CHECKPOINT_KIND.FIRST_WRITE);
}

/** Before `rm -r`, `git reset --hard` and the like, spaced so a loop keeps one tree. */
export async function checkpointBeforeCommand(
  scene: CheckpointScene,
  argv: readonly string[],
): Promise<Milestone | null> {
  const command = destructiveCommand(argv);
  return command === null ? null : keep(scene, CHECKPOINT_KIND.DESTRUCTIVE, command);
}

/** The same for a whole shell line, ruled on by its first destructive command. */
export async function checkpointBeforeLine(
  scene: CheckpointScene,
  line: string,
): Promise<Milestone | null> {
  const command = destructiveInLine(line);
  return command === null ? null : keep(scene, CHECKPOINT_KIND.DESTRUCTIVE, command);
}
