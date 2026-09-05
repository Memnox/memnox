import { DECISION_EFFECT } from '../constants/decision.constants';
import type { Policy } from './policy';

/**
 * The same rules, written in the agent's own permission format. A rule Memnox holds
 * is enforced when the agent goes through us; a rule compiled into the agent's config
 * is enforced even when it does not. Both, or a bypass is a gap.
 */

export const NATIVE_TARGET = {
  CLAUDE_CODE: 'claude-code',
} as const;

export type NativeTarget = (typeof NATIVE_TARGET)[keyof typeof NATIVE_TARGET];

export interface ClaudeCodePermissions {
  allow: string[];
  ask: string[];
  deny: string[];
}

/**
 * Memnox actions are namespaced verbs; Claude Code's permissions are tool names with
 * an argument pattern. The mapping is stated rather than derived, because a wrong
 * guess here writes a permission somebody did not ask for into their editor.
 */
const TOOL_FOR_ACTION: Readonly<Record<string, string>> = {
  'filesystem.read': 'Read',
  'filesystem.write': 'Write',
  'file.write': 'Write',
  'filesystem.delete': 'Bash',
  'shell.execute': 'Bash',
  'http.request': 'WebFetch',
  'package.install': 'Bash',
};

const GIT_PREFIX = 'git.';

function nativeRuleFor(action: string, target?: string): string | null {
  if (action.startsWith(GIT_PREFIX)) {
    const sub = action.slice(GIT_PREFIX.length);
    return `Bash(git ${sub}:*)`;
  }
  const tool = TOOL_FOR_ACTION[action];
  if (tool === undefined) return null;
  return target === undefined || target === '' ? tool : `${tool}(${target})`;
}

export interface NativeTranslation {
  permissions: ClaudeCodePermissions;
  /** Rules with no native equivalent. Named, never silently dropped. */
  untranslated: { policy: string; because: string }[];
}

export function toClaudeCodePermissions(policies: readonly Policy[]): NativeTranslation {
  const permissions: ClaudeCodePermissions = { allow: [], ask: [], deny: [] };
  const untranslated: { policy: string; because: string }[] = [];

  for (const policy of policies) {
    const actions = policy.match.actions ?? [];
    if (actions.length === 0) {
      untranslated.push({
        policy: policy.name,
        because: 'it names no action, so there is nothing to write',
      });
      continue;
    }

    const targets = policy.match.targets ?? [undefined];
    let wrote = false;
    for (const action of actions) {
      for (const target of targets) {
        const native = nativeRuleFor(action, target);
        if (native === null) continue;
        const bucket =
          policy.decision.effect === DECISION_EFFECT.DENY
            ? permissions.deny
            : policy.decision.effect === DECISION_EFFECT.ASK
              ? permissions.ask
              : permissions.allow;
        if (!bucket.includes(native)) bucket.push(native);
        wrote = true;
      }
    }
    if (!wrote) {
      untranslated.push({
        policy: policy.name,
        because: `no Claude Code permission covers ${actions.join(', ')}`,
      });
    }
  }

  return { permissions, untranslated };
}

/** Marks what we wrote, so a revert puts back exactly what was there and no more. */
export const NATIVE_MARKER = '_memnoxManaged';

export interface NativeSettings {
  permissions?: Partial<ClaudeCodePermissions>;
  [key: string]: unknown;
}

/**
 * Merged, never replaced. Somebody's own allow list is theirs; ours is added beside
 * it and recorded under the marker so removing ours cannot remove theirs.
 */
export function applyNative(
  settings: NativeSettings,
  translation: NativeTranslation,
): NativeSettings {
  const existing = settings.permissions ?? {};
  const ours = translation.permissions;
  const merge = (mine: string[], theirs: string[] | undefined): string[] => [
    ...new Set([...(theirs ?? []), ...mine]),
  ];

  return {
    ...settings,
    permissions: {
      allow: merge(ours.allow, existing.allow),
      ask: merge(ours.ask, existing.ask),
      deny: merge(ours.deny, existing.deny),
    },
    [NATIVE_MARKER]: {
      allow: ours.allow,
      ask: ours.ask,
      deny: ours.deny,
    },
  };
}

/** Takes back only what the marker says we wrote. */
export function revertNative(settings: NativeSettings): NativeSettings {
  const managed = settings[NATIVE_MARKER] as Partial<ClaudeCodePermissions> | undefined;
  if (managed === undefined) return settings;

  const existing = settings.permissions ?? {};
  const without = (theirs: string[] | undefined, mine: string[] | undefined): string[] =>
    (theirs ?? []).filter((entry) => !(mine ?? []).includes(entry));

  const restored: NativeSettings = {
    ...settings,
    permissions: {
      allow: without(existing.allow, managed.allow),
      ask: without(existing.ask, managed.ask),
      deny: without(existing.deny, managed.deny),
    },
  };
  delete restored[NATIVE_MARKER];
  return restored;
}
