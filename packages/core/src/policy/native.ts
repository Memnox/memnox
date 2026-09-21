import { DECISION_EFFECT, type DecisionEffect } from '../constants/decision.constants';
import type { Policy } from './policy';

/**
 * The same rules, written in the agent's own permission format, so they hold even when
 * the agent does not go through Memnox. Both, or a bypass is a gap.
 */

/** A rule with no native equivalent. Named, never silently dropped. */
export interface Untranslated {
  policy: string;
  because: string;
}

const NAMES_NO_ACTION = 'it names no action, so there is nothing to write';

/** Ours added beside theirs, theirs first, each entry once. */
function mergeLists(
  ours: readonly string[],
  theirs: readonly string[] | undefined,
): string[] {
  return [...new Set([...(theirs ?? []), ...ours])];
}

/** Theirs, less whatever we wrote. */
function withoutOurs(
  theirs: readonly string[] | undefined,
  ours: readonly string[] | undefined,
): string[] {
  return (theirs ?? []).filter((entry) => !(ours ?? []).includes(entry));
}

function pushOnce(list: string[], entry: string): void {
  if (!list.includes(entry)) list.push(entry);
}

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
 * Renders an MCP action as Claude Code's `mcp__<server>__<tool>`, with no parentheses
 * because Claude Code skips any `mcp__` rule that has them.
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
  untranslated: Untranslated[];
}

/** Where each effect is written in Claude Code's settings. */
function claudeBucket(
  permissions: ClaudeCodePermissions,
  effect: DecisionEffect,
): string[] {
  if (effect === DECISION_EFFECT.DENY) return permissions.deny;
  if (effect === DECISION_EFFECT.ASK) return permissions.ask;
  return permissions.allow;
}

/** Writes one policy's rules, or says why none could be written. */
function writeClaudeRules(
  policy: Policy,
  actions: readonly string[],
  permissions: ClaudeCodePermissions,
): Untranslated | null {
  const allowing = policy.decision.effect === DECISION_EFFECT.ALLOW;
  let wrote = false;
  let skippedUnanchored = false;
  for (const action of actions) {
    for (const target of policy.match.targets ?? [undefined]) {
      const native = nativeRuleFor(action, target);
      if (native === null) continue;
      // Claude Code skips an unanchored MCP allow glob, so writing one would do nothing.
      if (allowing && native.startsWith('mcp__*')) {
        skippedUnanchored = true;
        continue;
      }
      pushOnce(claudeBucket(permissions, policy.decision.effect), native);
      wrote = true;
    }
  }
  if (wrote) return null;
  return {
    policy: policy.name,
    because: skippedUnanchored
      ? 'an allow rule for an MCP tool has to name its server; Claude Code skips an unanchored glob'
      : `no Claude Code permission covers ${actions.join(', ')}`,
  };
}

export function toClaudeCodePermissions(policies: readonly Policy[]): NativeTranslation {
  const permissions: ClaudeCodePermissions = { allow: [], ask: [], deny: [] };
  const untranslated: Untranslated[] = [];
  for (const policy of policies) {
    const actions = policy.match.actions ?? [];
    const skipped =
      actions.length === 0
        ? { policy: policy.name, because: NAMES_NO_ACTION }
        : writeClaudeRules(policy, actions, permissions);
    if (skipped !== null) untranslated.push(skipped);
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
  return {
    ...settings,
    permissions: {
      allow: mergeLists(ours.allow, existing.allow),
      ask: mergeLists(ours.ask, existing.ask),
      deny: mergeLists(ours.deny, existing.deny),
    },
    [NATIVE_MARKER]: { allow: ours.allow, ask: ours.ask, deny: ours.deny },
  };
}

/** Takes back only what the marker says we wrote. */
export function revertNative(settings: NativeSettings): NativeSettings {
  // The marker is only ever written by `applyNative`, in this shape.
  const managed = settings[NATIVE_MARKER] as Partial<ClaudeCodePermissions> | undefined;
  if (managed === undefined) return settings;

  const existing = settings.permissions ?? {};
  const restored: NativeSettings = {
    ...settings,
    permissions: {
      allow: withoutOurs(existing.allow, managed.allow),
      ask: withoutOurs(existing.ask, managed.ask),
      deny: withoutOurs(existing.deny, managed.deny),
    },
  };
  delete restored[NATIVE_MARKER];
  return restored;
}

/**
 * OpenClaw's two lists, allow and deny, with no third effect: an ask is reported
 * untranslated and stays with the seams, which do have three.
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
  untranslated: Untranslated[];
}

/** The OpenClaw tools these actions reach; git and anything shell-shaped goes through exec. */
function openClawToolsFor(actions: readonly string[]): Set<string> {
  const named = new Set<string>();
  for (const action of actions) {
    const mapped = action.startsWith(GIT_PREFIX)
      ? ['exec']
      : (OPENCLAW_TOOLS[action] ?? []);
    for (const tool of mapped) named.add(tool);
  }
  return named;
}

/** Why a policy cannot be written as OpenClaw tools, or null when it can. */
function openClawSkip(policy: Policy, actions: readonly string[]): Untranslated | null {
  if (actions.length === 0) return { policy: policy.name, because: NAMES_NO_ACTION };
  if (policy.decision.effect === DECISION_EFFECT.ASK) {
    return {
      policy: policy.name,
      because: 'OpenClaw has allow and deny only, and an ask written as either is wrong',
    };
  }
  return null;
}

export function toOpenClawTools(policies: readonly Policy[]): OpenClawTranslation {
  const tools: OpenClawTools = { allow: [], deny: [] };
  const untranslated: Untranslated[] = [];
  for (const policy of policies) {
    const actions = policy.match.actions ?? [];
    const skipped = openClawSkip(policy, actions);
    if (skipped !== null) {
      untranslated.push(skipped);
      continue;
    }
    const named = openClawToolsFor(actions);
    if (named.size === 0) {
      untranslated.push({
        policy: policy.name,
        because: `no OpenClaw tool covers ${actions.join(', ')}`,
      });
      continue;
    }
    const bucket =
      policy.decision.effect === DECISION_EFFECT.DENY ? tools.deny : tools.allow;
    for (const tool of named) pushOnce(bucket, tool);
  }
  // Deny wins in OpenClaw, so a tool in both lists would read as a contradiction.
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
  return {
    ...settings,
    tools: {
      ...existing,
      allow: mergeLists(ours.allow, existing.allow),
      deny: mergeLists(ours.deny, existing.deny),
    },
    [NATIVE_MARKER]: { allow: ours.allow, deny: ours.deny },
  };
}

export function revertOpenClaw(settings: OpenClawSettings): OpenClawSettings {
  // The marker is only ever written by `applyOpenClaw`, in this shape.
  const managed = settings[NATIVE_MARKER] as Partial<OpenClawTools> | undefined;
  if (managed === undefined) return settings;

  const existing = settings.tools ?? {};
  const restored: OpenClawSettings = {
    ...settings,
    tools: {
      ...existing,
      allow: withoutOurs(existing.allow, managed.allow),
      deny: withoutOurs(existing.deny, managed.deny),
    },
  };
  delete restored[NATIVE_MARKER];
  return restored;
}

/**
 * Hermes blocks commands with `approvals.deny`, fnmatch globs in `config.yaml`. It fires
 * before any yolo bypass, which makes it the strongest seat for a deny.
 */
export interface HermesTranslation {
  deny: string[];
  untranslated: Untranslated[];
}

/** Why a policy cannot be written into `approvals.deny`, or null when it can. */
function hermesSkip(policy: Policy, actions: readonly string[]): Untranslated | null {
  if (actions.length === 0) return { policy: policy.name, because: NAMES_NO_ACTION };
  // `approvals.deny` cannot be answered, so an ask written there would become a refusal.
  if (policy.decision.effect !== DECISION_EFFECT.DENY) {
    return {
      policy: policy.name,
      because: 'approvals.deny is unconditional, so only a deny belongs in it',
    };
  }
  return null;
}

export function toHermesApprovals(
  policies: readonly Policy[],
  globFor: (action: string) => string | null,
): HermesTranslation {
  const deny: string[] = [];
  const untranslated: Untranslated[] = [];
  for (const policy of policies) {
    const actions = policy.match.actions ?? [];
    const skipped = hermesSkip(policy, actions);
    if (skipped !== null) {
      untranslated.push(skipped);
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
    // Lowercase, because Hermes lowers both sides before matching.
    for (const glob of globs) pushOnce(deny, glob.toLowerCase());
  }
  return { deny, untranslated };
}
