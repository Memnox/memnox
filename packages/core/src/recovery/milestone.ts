/**
 * A working tree, kept. An agent that runs for three hours unsupervised writes a broken
 * migration, reformats forty files nobody asked about and deletes a directory it misread
 * — none of it committed, so `git checkout .` throws the good away with the bad.
 *
 * What is kept is a tree object under `refs/memnox/`, where nothing else looks. Never a
 * branch, never a commit on one, never the stash: this has to be invisible to everything
 * a person does with git afterwards, or the cure is worse than the mess.
 */

export const MILESTONE_REF_PREFIX = 'refs/memnox/milestones';

export const MILESTONE_REASON = {
  /** An agent session started. The one that matters. */
  SESSION: 'session',
  /** Somebody asked for one. */
  MANUAL: 'manual',
  /** Taken by a rewind, so the thing it replaced stays reachable. */
  REPLACED: 'replaced',
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
  if (milestone.note !== undefined) fields.push(`note: ${milestone.note}`);
  return `${fields.join('\n')}\n`;
}

const REASONS: readonly string[] = Object.values(MILESTONE_REASON);

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
  const note = fields.get('note');
  return {
    takenAt,
    reason: (REASONS.includes(reason)
      ? reason
      : MILESTONE_REASON.MANUAL) as MilestoneReason,
    files: Number(fields.get('files') ?? 0),
    ...(session === undefined ? {} : { sessionId: session }),
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
    Math.round((Date.parse(moment) - Date.parse(milestone.takenAt)) / 1000),
  );
  const ago =
    seconds < 90
      ? `${seconds}s ago`
      : seconds < 5400
        ? `${Math.round(seconds / 60)}m ago`
        : `${Math.round(seconds / 3600)}h ago`;
  const what = milestone.note ?? milestone.reason;
  return `${milestone.id}  ${ago.padEnd(9)}${String(milestone.files).padStart(4)} file(s)  ${what}`;
}
