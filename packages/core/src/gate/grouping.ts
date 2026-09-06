import type { PendingApproval } from './pending';

/**
 * Five similar questions, asked once.
 *
 * An agent doing real work generates hundreds of held calls, and a tool that asks
 * about each one separately is a tool people turn off — at which point it protects
 * nothing. Grouping is not a convenience here; it is what makes high autonomy and low
 * interruption possible at the same time.
 *
 * Only identical *kinds* of work group. The line is drawn at the operation and the
 * shape of the target, never at "these look similar", because a person answering one
 * question for five actions has to be able to see exactly what they answered for.
 */

export interface ApprovalGroup {
  /** The operation every member shares. This is what the person is answering about. */
  operation: string;
  agent: string;
  members: PendingApproval[];
  /** Distinct targets, so the prompt can show what is actually covered. */
  targets: string[];
}

/**
 * The part of a target that makes two calls the same kind of work.
 *
 * A directory rather than a file: writing ten files in `src/checkout` is one decision
 * and ten paths. Anything without a separator stands for itself — a host, a branch and
 * a table are not usefully generalised, and pretending otherwise would group calls a
 * person did not mean to answer together.
 */
export function targetFamily(target: string | undefined): string {
  if (target === undefined || target.trim() === '') return '';
  const cut = target.lastIndexOf('/');
  return cut <= 0 ? target : target.slice(0, cut);
}

export function groupKey(pending: PendingApproval): string {
  return [
    pending.request.agent,
    pending.request.operation,
    targetFamily(pending.request.target),
  ].join('|');
}

/**
 * Grouped, largest first. A group of one is still a group: the caller renders it as a
 * single question, and having two shapes on screen for the same thing is worse than
 * one row that happens to cover one call.
 */
export function groupPending(pending: readonly PendingApproval[]): ApprovalGroup[] {
  const groups = new Map<string, ApprovalGroup>();
  for (const each of pending) {
    const key = groupKey(each);
    const group = groups.get(key) ?? {
      operation: each.request.operation,
      agent: each.request.agent,
      members: [],
      targets: [],
    };
    group.members.push(each);
    const target = each.request.target;
    if (target !== undefined && !group.targets.includes(target)) {
      group.targets.push(target);
    }
    groups.set(key, group);
  }

  return [...groups.values()].sort(
    (a, b) =>
      b.members.length - a.members.length || a.operation.localeCompare(b.operation),
  );
}

/** The one line a person reads before answering for the whole group. */
export function describeGroup(group: ApprovalGroup): string {
  const count = group.members.length;
  const what = count === 1 ? '1 call' : `${count} calls`;
  const where =
    group.targets.length === 0
      ? ''
      : group.targets.length === 1
        ? ` on ${group.targets[0]}`
        : ` across ${group.targets.length} targets`;
  return `${group.agent} wants to ${group.operation}${where} — ${what}`;
}

/**
 * What a person is agreeing to, spelled out.
 *
 * Shown before a group is answered, always, and capped: a decision covering forty
 * calls is one somebody has to be able to read, and a wall of paths is the same as
 * showing nothing at all.
 */
export function groupDetail(group: ApprovalGroup, limit = 5): string[] {
  const shown = group.targets.slice(0, limit).map((target) => `  ${target}`);
  if (group.targets.length > limit) {
    shown.push(`  and ${group.targets.length - limit} more`);
  }
  return shown;
}
