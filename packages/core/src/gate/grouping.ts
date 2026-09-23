import type { PendingApproval } from './pending';

/**
 * Similar held calls asked about once, grouped only by the operation and the shape of
 * the target, because one answer has to cover something checkable.
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
 * The directory, since ten files in `src/checkout` are one decision. Anything without a
 * separator stands for itself: a host, a branch and a table do not generalise.
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

/** Grouped, largest first. A group of one is still a group, so the screen has one shape. */
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
  return `${group.agent} wants to ${group.operation}${describeTargets(group.targets)}: ${what}`;
}

function describeTargets(targets: readonly string[]): string {
  if (targets.length === 0) return '';
  if (targets.length === 1) return ` on ${targets[0]}`;
  return ` across ${targets.length} targets`;
}

/** Enough targets to see what a group covers, and few enough that somebody reads them. */
const TARGETS_SHOWN = 5;

/** What a person is agreeing to, always shown and capped, since a wall of paths shows nothing. */
export function groupDetail(group: ApprovalGroup, limit = TARGETS_SHOWN): string[] {
  const shown = group.targets.slice(0, limit).map((target) => `  ${target}`);
  if (group.targets.length > limit) {
    shown.push(`  and ${group.targets.length - limit} more`);
  }
  return shown;
}
