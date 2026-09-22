/**
 * A working tree kept as a tree object under `refs/memnox/`, never a branch or the stash, so
 * good and bad agent work can be separated without `git checkout .` taking both.
 */
import { msToSeconds, secondsToMs } from '../domain/time';
import {
  describeSpan,
  IN_SECONDS_THEN_MINUTES_THEN_HOURS,
} from '../domain/duration-text';
export const MILESTONE_REF_PREFIX = 'refs/memnox/milestones';

export const MILESTONE_REASON = {
  /** An agent session started. The one that matters. */
  SESSION: 'session',
  /** Somebody asked for one. */
  MANUAL: 'manual',
  /** Taken by a rewind, so the thing it replaced stays reachable. */
  REPLACED: 'replaced',
  /** Taken by an editor's hook before a session's first write in this repository. */
  FIRST_WRITE: 'first-write',
  /** Taken by a seam before a command that deletes or overwrites work. */
  DESTRUCTIVE: 'destructive',
} as const;

export type MilestoneReason = (typeof MILESTONE_REASON)[keyof typeof MILESTONE_REASON];

export interface Milestone {
  id: string;
  /** The commit object holding the tree. Everything else is derived from it. */
  commit: string;
  takenAt: string;
  reason: MilestoneReason;
  /** The session it belongs to, when one was running. */
  sessionId?: string;
  /** The agent whose session it was, so a listing says whose work it guards. */
  agent?: string;
  /** What was about to happen, in the words a listing will show. */
  note?: string;
  /** Counts, so a listing says how much is at stake without reading the tree. */
  files: number;
}

export function milestoneIdFor(at: string, commit: string): string {
  return `mst_${Date.parse(at).toString(36)}${commit.slice(0, 4)}`;
}

export function refFor(id: string): string {
  return `${MILESTONE_REF_PREFIX}/${id}`;
}

export function idFromRef(ref: string): string | null {
  if (!ref.startsWith(`${MILESTONE_REF_PREFIX}/`)) return null;
  const id = ref.slice(MILESTONE_REF_PREFIX.length + 1);
  return id === '' ? null : id;
}

/**
 * The message is the record: a ref holds one sha and nothing else, and a sidecar file
 * would go missing exactly when somebody needs it. Parsed back leniently, because a
 * milestone that will not parse must still be restorable.
 */
export function encodeMessage(milestone: Omit<Milestone, 'id' | 'commit'>): string {
  const fields = [
    `memnox-milestone ${milestone.takenAt}`,
    '',
    `reason: ${milestone.reason}`,
    `files: ${milestone.files}`,
  ];
  if (milestone.sessionId !== undefined) fields.push(`session: ${milestone.sessionId}`);
  if (milestone.agent !== undefined) fields.push(`agent: ${milestone.agent}`);
  if (milestone.note !== undefined) fields.push(`note: ${milestone.note}`);
  return `${fields.join('\n')}\n`;
}

const REASONS: readonly string[] = Object.values(MILESTONE_REASON);

function isMilestoneReason(value: string): value is MilestoneReason {
  return REASONS.includes(value);
}

export function decodeMessage(message: string): Omit<Milestone, 'id' | 'commit'> | null {
  const [header, ...rest] = message.split('\n');
  if (header === undefined || !header.startsWith('memnox-milestone ')) return null;
  const takenAt = header.slice('memnox-milestone '.length).trim();

  const fields = new Map<string, string>();
  for (const line of rest) {
    const at = line.indexOf(': ');
    if (at > 0) fields.set(line.slice(0, at), line.slice(at + 2));
  }
  const reason = fields.get('reason') ?? MILESTONE_REASON.MANUAL;
  const session = fields.get('session');
  const agent = fields.get('agent');
  const note = fields.get('note');
  return {
    takenAt,
    reason: isMilestoneReason(reason) ? reason : MILESTONE_REASON.MANUAL,
    files: Number(fields.get('files') ?? 0),
    ...(session === undefined ? {} : { sessionId: session }),
    ...(agent === undefined ? {} : { agent }),
    ...(note === undefined ? {} : { note }),
  };
}

/** How many milestones a repository keeps. Enough for a night, not enough to notice. */
export const MILESTONE_KEEP = 20;

/** Oldest first out, and the newest is never dropped whatever the count says. */
export function milestonesToForget(
  milestones: readonly Milestone[],
  keep: number = MILESTONE_KEEP,
): Milestone[] {
  const ordered = [...milestones].sort((a, b) => b.takenAt.localeCompare(a.takenAt));
  return ordered.slice(Math.max(1, keep));
}

export function describeMilestone(milestone: Milestone, moment: string): string {
  const seconds = Math.max(
    0,
    msToSeconds(Date.parse(moment) - Date.parse(milestone.takenAt)),
  );
  const ago = `${describeSpan(secondsToMs(seconds), IN_SECONDS_THEN_MINUTES_THEN_HOURS)} ago`;
  const what = milestone.note ?? milestone.reason;
  return `${milestone.id}  ${ago.padEnd(9)}${String(milestone.files).padStart(4)} file(s)  ${what}${whoseOf(milestone)}`;
}

/** The agent and session a milestone guards, where it was taken for one. */
function whoseOf(milestone: Milestone): string {
  const whose = [milestone.agent, milestone.sessionId].filter(
    (part): part is string => part !== undefined,
  );
  return whose.length === 0 ? '' : `  (${whose.join(', ')})`;
}

/** The milestones a session's own seams took, oldest first. */
export function milestonesOfSession(
  milestones: readonly Milestone[],
  sessionId: string,
): Milestone[] {
  return milestones
    .filter((milestone) => milestone.sessionId === sessionId)
    .sort((a, b) => a.takenAt.localeCompare(b.takenAt));
}
