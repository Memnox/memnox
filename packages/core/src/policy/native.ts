import { DECISION_EFFECT } from '../constants/decision.constants';
import type { Policy } from './policy';

/**
 * The same rules, written in the agent's own permission format. A rule Memnox holds
 * is enforced when the agent goes through us; a rule compiled into the agent's config
 * is enforced even when it does not. Both, or a bypass is a gap.
 */

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
const MCP_PREFIX = 'mcp.';

/**
 * An MCP tool in Claude Code's own naming: `mcp__<server>__<tool>`.
 *
 * A Memnox action names the tool and not the server, because the proxy rules on a call
 * before it knows which of several configs launched that server. Claude Code accepts a
 * glob in the tool-name position for a deny or an ask, so `mcp__*__delete_customer` is
 * the honest translation — and it deliberately carries no parentheses, because Claude
 * Code skips any `mcp__` rule that has them.
 */
function mcpRuleFor(action: string): string {
  const rest = action.slice(MCP_PREFIX.length);
  const dot = rest.indexOf('.');
  // A rule that names its server compiles to that server; one that does not spans all.
  return dot === -1
    ? `mcp__*__${rest}`
    : `mcp__${rest.slice(0, dot)}__${rest.slice(dot + 1)}`;
}

function nativeRuleFor(action: string, target?: string): string | null {
  if (action.startsWith(GIT_PREFIX)) {
    const sub = action.slice(GIT_PREFIX.length);
    return `Bash(git ${sub}:*)`;
  }
  if (action.startsWith(MCP_PREFIX)) return mcpRuleFor(action);
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
    const allowing = policy.decision.effect === DECISION_EFFECT.ALLOW;
    let wrote = false;
    let skippedUnanchored = false;

    for (const action of actions) {
      for (const target of targets) {
        const native = nativeRuleFor(action, target);
        if (native === null) continue;
        /* Claude Code skips an allow glob that does not name a server, with a warning.
           Writing one would put a line in somebody's settings that does nothing, so
           the rule is reported as untranslated instead. */
        if (allowing && native.startsWith('mcp__*')) {
          skippedUnanchored = true;
          continue;
        }
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
        because: skippedUnanchored
          ? 'an allow rule for an MCP tool has to name its server; Claude Code skips an unanchored glob'
          : `no Claude Code permission covers ${actions.join(', ')}`,
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

/**
 * OpenClaw names its own tools and gates them with one allow list and one deny list.
 *
 * It has no third effect. A Memnox ASK cannot be written here at all: putting it in
 * `allow` would silently drop the approval somebody asked for, and putting it in
 * `deny` would break work that was meant to continue after a prompt. So an ASK is
 * reported as untranslated and stays with the seams, which do have three effects.
 */
export interface OpenClawTools {
  allow: string[];
  deny: string[];
}

/** Memnox actions against the tool names OpenClaw actually publishes. */
const OPENCLAW_TOOLS: Readonly<Record<string, readonly string[]>> = {
  'filesystem.read': ['read'],
  'filesystem.write': ['write', 'edit', 'apply_patch'],
  'file.write': ['write', 'edit', 'apply_patch'],
  'filesystem.delete': ['exec'],
  'shell.execute': ['exec', 'process'],
  'package.install': ['exec'],
  'browser.navigate': ['browser'],
};

export interface OpenClawTranslation {
  tools: OpenClawTools;
  untranslated: { policy: string; because: string }[];
}

export function toOpenClawTools(policies: readonly Policy[]): OpenClawTranslation {
  const tools: OpenClawTools = { allow: [], deny: [] };
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
    if (policy.decision.effect === DECISION_EFFECT.ASK) {
      untranslated.push({
        policy: policy.name,
        because:
          'OpenClaw has allow and deny only, and an ask written as either is wrong',
      });
      continue;
    }

    const named = new Set<string>();
    for (const action of actions) {
      // git and everything else shell-shaped reaches the world through exec.
      const mapped = action.startsWith(GIT_PREFIX)
        ? ['exec']
        : (OPENCLAW_TOOLS[action] ?? []);
      for (const tool of mapped) named.add(tool);
    }
    if (named.size === 0) {
      untranslated.push({
        policy: policy.name,
        because: `no OpenClaw tool covers ${actions.join(', ')}`,
      });
      continue;
    }

    const bucket =
      policy.decision.effect === DECISION_EFFECT.DENY ? tools.deny : tools.allow;
    for (const tool of named) if (!bucket.includes(tool)) bucket.push(tool);
  }

  /* Deny wins in OpenClaw, so a tool in both lists is denied. Leaving it in `allow`
     as well would read as a contradiction to whoever opens the file next. */
  tools.allow = tools.allow.filter((tool) => !tools.deny.includes(tool));
  return { tools, untranslated };
}

export interface OpenClawSettings {
  tools?: { allow?: string[]; deny?: string[]; [key: string]: unknown };
  [key: string]: unknown;
}

/** Merged beside whatever is already there, and recorded so a revert takes only ours. */
export function applyOpenClaw(
  settings: OpenClawSettings,
  translation: OpenClawTranslation,
): OpenClawSettings {
  const existing = settings.tools ?? {};
  const ours = translation.tools;
  const merge = (mine: string[], theirs: string[] | undefined): string[] => [
    ...new Set([...(theirs ?? []), ...mine]),
  ];

  return {
    ...settings,
    tools: {
      ...existing,
      allow: merge(ours.allow, existing.allow),
      deny: merge(ours.deny, existing.deny),
    },
    [NATIVE_MARKER]: { allow: ours.allow, deny: ours.deny },
  };
}

export function revertOpenClaw(settings: OpenClawSettings): OpenClawSettings {
  const managed = settings[NATIVE_MARKER] as Partial<OpenClawTools> | undefined;
  if (managed === undefined) return settings;

  const existing = settings.tools ?? {};
  const without = (theirs: string[] | undefined, mine: string[] | undefined): string[] =>
    (theirs ?? []).filter((entry) => !(mine ?? []).includes(entry));

  const restored: OpenClawSettings = {
    ...settings,
    tools: {
      ...existing,
      allow: without(existing.allow, managed.allow),
      deny: without(existing.deny, managed.deny),
    },
  };
  delete restored[NATIVE_MARKER];
  return restored;
}

/**
 * Hermes blocks commands with `approvals.deny`, a list of fnmatch globs read straight
 * out of `config.yaml`. Verified against its own source rather than its docs, which
 * disagree with each other about whether the key exists: `tools/approval_floors.py`
 * reads it, matches lowercased on both sides, and fires *before* any yolo bypass —
 * "never let the agent run this, even under yolo". That is the strongest place a rule
 * can sit in that product, so a deny compiles into it.
 */
export interface HermesTranslation {
  deny: string[];
  untranslated: { policy: string; because: string }[];
}

export function toHermesApprovals(
  policies: readonly Policy[],
  globFor: (action: string) => string | null,
): HermesTranslation {
  const deny: string[] = [];
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
    /* Only a deny compiles. `approvals.deny` is unconditional and cannot be answered,
       so writing an ask into it would turn a question into a refusal. */
    if (policy.decision.effect !== DECISION_EFFECT.DENY) {
      untranslated.push({
        policy: policy.name,
        because: 'approvals.deny is unconditional, so only a deny belongs in it',
      });
      continue;
    }

    const globs = actions
      .map(globFor)
      .filter((glob): glob is string => glob !== null && glob !== '');
    if (globs.length === 0) {
      untranslated.push({
        policy: policy.name,
        because: `no command pattern covers ${actions.join(', ')}`,
      });
      continue;
    }
    // Lowercase: Hermes lowers both sides before matching, so this is what it compares.
    for (const glob of globs) {
      const lowered = glob.toLowerCase();
      if (!deny.includes(lowered)) deny.push(lowered);
    }
  }

  return { deny, untranslated };
}
