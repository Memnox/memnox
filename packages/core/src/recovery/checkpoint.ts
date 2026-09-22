/**
 * When a seam keeps a milestone on its own: once before a session first writes in a
 * repository, and again before a destructive command, but never twice within a spacing,
 * so an agent deleting in a loop does not pile up trees.
 */
import { MILESTONE_REASON } from './milestone';

export const CHECKPOINT_KIND = {
  FIRST_WRITE: MILESTONE_REASON.FIRST_WRITE,
  DESTRUCTIVE: MILESTONE_REASON.DESTRUCTIVE,
} as const;

export type CheckpointKind = (typeof CHECKPOINT_KIND)[keyof typeof CHECKPOINT_KIND];

/** The least time between two destructive checkpoints of one session in one place. */
export const DESTRUCTIVE_SPACING_MS = 20_000;

/** Sessions remembered, newest kept, so the marks file stays a few kilobytes for ever. */
export const MARKED_SESSIONS = 64;

/** One session's checkpoints in one working directory, as the seams last saw them. */
export interface CheckpointMark {
  sessionId: string;
  /** The directory the session works in, which names the repository without asking git. */
  place: string;
  firstAt: string;
  lastAt: string;
}

export interface CheckpointRequest {
  kind: CheckpointKind;
  sessionId: string;
  agent: string;
  place: string;
  at: string;
  note?: string;
}

function markOf(
  marks: readonly CheckpointMark[],
  request: CheckpointRequest,
): CheckpointMark | undefined {
  return marks.find(
    (mark) => mark.sessionId === request.sessionId && mark.place === request.place,
  );
}

/** Whether this request earns a milestone, given the ones this session already has. */
export function checkpointDue(
  marks: readonly CheckpointMark[],
  request: CheckpointRequest,
  spacingMs: number = DESTRUCTIVE_SPACING_MS,
): boolean {
  const mark = markOf(marks, request);
  if (mark === undefined) return true;
  // The first write is kept once: anything already kept for the session came before it.
  if (request.kind === CHECKPOINT_KIND.FIRST_WRITE) return false;
  return Date.parse(request.at) - Date.parse(mark.lastAt) >= spacingMs;
}

/** The marks once this request's milestone is taken, newest sessions kept. */
export function markTaken(
  marks: readonly CheckpointMark[],
  request: CheckpointRequest,
  keep: number = MARKED_SESSIONS,
): CheckpointMark[] {
  const mark = markOf(marks, request);
  const others = marks.filter((each) => each !== mark);
  const next: CheckpointMark = {
    sessionId: request.sessionId,
    place: request.place,
    firstAt: mark === undefined ? request.at : mark.firstAt,
    lastAt: request.at,
  };
  return [next, ...others]
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
    .slice(0, keep);
}
