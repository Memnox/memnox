import { leasePathFor, leaseScopeFor, proceeds } from '@memnox/core';

import {
  changeIn,
  EDIT_CHANGE,
  fieldsOf,
  firstText,
  type EditChange,
  type EditIntent,
} from './hook-payload';
import type { SeamLeases } from './seam-runtime';

/**
 * The lease an editor's own file tools take before they write.
 * Coordination only, since the rules are `tool-policy.ts`, and
 * bounded, since a hook that waits as long as a terminal is killed.
 */

/** The tools that write a file, by the name Claude Code gives them. */
export const EDIT_TOOLS: readonly string[] = [
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
];

/** The events this hook is installed for. */
export const EDIT_HOOK_EVENT = {
  PRE_TOOL_USE: 'PreToolUse',
  SESSION_END: 'SessionEnd',
  /** Every tool call, once it returns: what the agent did, and any note waiting. */
  POST_TOOL_USE: 'PostToolUse',
  /** The turn ended: a person's note waiting is handed over as the next thing to do. */
  STOP: 'Stop',
  /** The person asked for something: any note waiting rides beside their words. */
  USER_PROMPT_SUBMIT: 'UserPromptSubmit',
  /** A session began: the boundary is said once, as context. Codex and Gemini CLI share the name. */
  SESSION_START: 'SessionStart',
} as const;

/**
 * What a refused agent is told on every retry:
 * this is temporary, work elsewhere meanwhile.
 */
export const COME_BACK =
  'Work on something else for now and come back to these lines later.';

/** The binary the hook runs as. */
export const EDIT_HOOK_BINARY = 'memnox-edit-hook';

/**
 * Milliseconds a held file is waited on: an editor
 * holds a file all session, so a long wait is wasted.
 */
export const EDIT_HOOK_WAIT_MS = 5_000;

/**
 * Minutes an editor's hold lasts without a sign of
 * life, since a working session renews every call.
 */
export const EDIT_IDLE_MINUTES = 5;

/** Where Claude Code names the file a write goes to. */
const PATH_KEYS: readonly string[] = ['file_path', 'notebook_path'];

/**
 * The write in a hook payload, read by exact field,
 * because guessing costs a lease on the wrong file.
 */
export function editOf(payload: unknown): EditIntent | null {
  const hook = fieldsOf(payload);
  if (hook === null || hook['hook_event_name'] !== EDIT_HOOK_EVENT.PRE_TOOL_USE)
    return null;
  const tool = hook['tool_name'];
  if (typeof tool !== 'string' || !EDIT_TOOLS.includes(tool)) return null;
  const session = hook['session_id'];
  if (typeof session !== 'string' || session.trim() === '') return null;

  const fields = fieldsOf(hook['tool_input']);
  if (fields === null) return null;
  const path = firstText(fields, PATH_KEYS);
  if (path === undefined || path.trim() === '') return null;

  const cwd = hook['cwd'];
  const change = changeIn(fields, ['content']);
  return {
    path,
    sessionId: session,
    ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}),
    ...(change === null ? {} : { change }),
  };
}

/**
 * The file as this edit will leave it, or null where a replacement's text is not in it.
 */
export function afterEdit(before: string, change: EditChange): string | null {
  if (change.kind === EDIT_CHANGE.WRITE) return change.content;
  let text = before;
  for (const each of change.replacements) {
    if (!text.includes(each.from)) return null;
    text = each.all
      ? text.split(each.from).join(each.to)
      : text.replace(each.from, () => each.to);
  }
  return text;
}

/**
 * What the host reads to refuse the write: the holder
 * and the way forward, so the model does not loop.
 */
export function editDenial(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: EDIT_HOOK_EVENT.PRE_TOOL_USE,
      permissionDecision: 'deny',
      permissionDecisionReason: `${reason} ${COME_BACK}`,
    },
  });
}

/** Why a write has to wait, and the workspace lease in its way where there is one. */
export interface EditRefusal {
  reason: string;
  /** The reason as a person is asked it, without a command to go and type. */
  asked?: string;
  /** The other machine's lease, which the person at this agent can take over. */
  leaseId?: string;
}

/** Takes the lease for one write. Null means go ahead. */
export async function claimEdit(
  edit: EditIntent,
  leases: SeamLeases,
): Promise<EditRefusal | null> {
  const path = leasePathFor(
    edit.path,
    leases.repositoryRoot,
    edit.cwd ?? leases.repositoryRoot,
  );
  // Outside the repository, or not a path at all:
  // no lease is invented, as the shell seam does.
  if (path === null) return null;

  // The file itself, since an editor names exactly
  // one; a directory lease still covers it.
  const scope = leases.isDirectory(path) ? leaseScopeFor(path, leases.isDirectory) : path;
  const verdict = await leases.gate.claim(
    scope,
    leases.holder,
    `edit ${path}`,
    EDIT_IDLE_MINUTES,
  );
  if (proceeds(verdict)) return null;
  return {
    reason: verdict.message ?? `${scope} is held by another agent.`,
    ...(verdict.asked === undefined ? {} : { asked: verdict.asked }),
    ...(verdict.sharedLeaseId === undefined ? {} : { leaseId: verdict.sharedLeaseId }),
  };
}

/** Permission modes in which Claude Code shows its person the prompt a hook asks for. */
const ASKING_MODES: readonly string[] = ['default', 'acceptEdits', 'plan'];

/** Whether this payload came from a session whose person will see a permission prompt. */
export function canAskPerson(payload: unknown): boolean {
  const mode = fieldsOf(payload)?.['permission_mode'];
  return typeof mode === 'string' && ASKING_MODES.includes(mode);
}

/**
 * The question put to the person at the agent: yes
 * takes the lines over on the record, no refuses.
 */
export function editAsk(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: EDIT_HOOK_EVENT.PRE_TOOL_USE,
      permissionDecision: 'ask',
      permissionDecisionReason: `${reason} Allow to take these lines over? The other agent will be told.`,
    },
  });
}
