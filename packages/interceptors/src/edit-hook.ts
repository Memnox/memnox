import { leasePathFor, leaseScopeFor, proceeds } from '@memnox/core';
import type { SeamLeases } from './seam-runtime';

/**
 * The lease an editor's own file tools take before they write.
 *
 * Every other seam here stands in front of a process: a shell command, a git push,
 * an MCP call. Claude Code's Write and Edit tools are none of those. They write the
 * file from inside the agent, so two sessions editing one file never met a lease at
 * all, and the promise that the seams take a lease on their own held for `sed -i`
 * and not for the tool an agent actually edits with.
 *
 * **Coordination only, never policy.** This takes the same lease the shell seam
 * takes and answers nothing else. A policy verdict on a tool call belongs to the
 * seams that already give one, and a second place ruling on rules is two answers
 * that would drift. So a refusal here only ever says who is writing the file.
 *
 * **Bounded, and never the reason work stops for good.** A hook that waited as long
 * as a terminal does would be killed by its host first, so the wait is shorter than
 * any host's hook timeout, and a register this cannot read lets the write through.
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
} as const;

/**
 * What a refused agent is told to do, in one sentence. It is read on every retry,
 * so it says the one useful thing: this is temporary, work elsewhere meanwhile.
 */
export const COME_BACK =
  'Work on something else for now and come back to these lines later.';

/** The binary the hook runs as. */
export const EDIT_HOOK_BINARY = 'memnox-edit-hook';

/**
 * Milliseconds a held file is waited on before the write is refused.
 *
 * Short, because an editor holds a file for its whole session rather than for one
 * write, so a long wait is time spent waiting on somebody who is not about to let
 * go. The refusal that follows is what the agent can act on: it names the holder
 * and the agent moves to other work.
 */
export const EDIT_HOOK_WAIT_MS = 5_000;

/** One replacement an edit tool makes: this text, for that one. */
export interface Replacement {
  from: string;
  to: string;
  /** Every occurrence rather than the one. */
  all: boolean;
}

/**
 * What the write does to the file, where the tool said.
 *
 * `edit` is a list of replacements in order, which is what Edit and MultiEdit
 * send. `write` is the whole new content, which is what Write sends. Absent
 * where the tool says neither, such as a notebook cell, and that is the whole
 * file.
 */
export type EditChange =
  { kind: 'edit'; replacements: Replacement[] } | { kind: 'write'; content: string };

/**
 * Minutes an editor's hold lasts without a sign of life.
 *
 * Short on purpose. The session's own hook renews everything it holds after each
 * tool call, so an agent that is working keeps the lines it changed however long
 * it works, and one that went quiet lets them go in minutes rather than the half
 * hour another agent on another computer would otherwise wait.
 */
export const EDIT_IDLE_MINUTES = 5;

/** One write an editor is about to make, as far as a lease needs to know it. */
export interface EditIntent {
  /** The file, as the tool named it: usually absolute. */
  path: string;
  /** The editor's own session, which is what makes a second edit a renewal. */
  sessionId: string;
  /** Where the session is working, which is what a relative path is relative to. */
  cwd?: string;
  /** What it changes, so the lease can name the lines rather than the file. */
  change?: EditChange;
}

/**
 * The write in a hook payload, or null for anything that is not one.
 *
 * Read by exact field, because the payload is the host's and the cost of guessing is
 * a lease on the wrong file.
 */
export function editOf(payload: unknown): EditIntent | null {
  if (payload === null || typeof payload !== 'object') return null;
  const hook = payload as Record<string, unknown>;
  if (hook['hook_event_name'] !== EDIT_HOOK_EVENT.PRE_TOOL_USE) return null;
  const tool = hook['tool_name'];
  if (typeof tool !== 'string' || !EDIT_TOOLS.includes(tool)) return null;
  const session = hook['session_id'];
  if (typeof session !== 'string' || session.trim() === '') return null;

  const input = hook['tool_input'];
  if (input === null || typeof input !== 'object') return null;
  const fields = input as Record<string, unknown>;
  const path = fields['file_path'] ?? fields['notebook_path'];
  if (typeof path !== 'string' || path.trim() === '') return null;

  const cwd = hook['cwd'];
  const change = changeOf(fields);
  return {
    path,
    sessionId: session,
    ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}),
    ...(change === null ? {} : { change }),
  };
}

/** The change in a tool's input, read by exact field, or null where it names none. */
function changeOf(fields: Record<string, unknown>): EditChange | null {
  const content = fields['content'];
  if (typeof content === 'string') return { kind: 'write', content };

  const one = replacementOf(fields);
  if (one !== null) return { kind: 'edit', replacements: [one] };

  const edits = fields['edits'];
  if (!Array.isArray(edits) || edits.length === 0) return null;
  const replacements: Replacement[] = [];
  for (const each of edits) {
    if (each === null || typeof each !== 'object') return null;
    const read = replacementOf(each as Record<string, unknown>);
    /* One edit this cannot read makes every line after it a guess, so the
       whole file is claimed instead. */
    if (read === null) return null;
    replacements.push(read);
  }
  return { kind: 'edit', replacements };
}

function replacementOf(fields: Record<string, unknown>): Replacement | null {
  const from = fields['old_string'];
  const to = fields['new_string'];
  if (typeof from !== 'string' || typeof to !== 'string' || from === '') return null;
  return { from, to, all: fields['replace_all'] === true };
}

/**
 * The file as this edit will leave it, or null where that cannot be told.
 *
 * Null when a replacement's text is not in the file, which is an edit the tool
 * itself is about to refuse, and then the whole file is claimed rather than a
 * guess at where it meant.
 */
export function afterEdit(before: string, change: EditChange): string | null {
  if (change.kind === 'write') return change.content;
  let text = before;
  for (const each of change.replacements) {
    if (!text.includes(each.from)) return null;
    text = each.all
      ? text.split(each.from).join(each.to)
      : text.replace(each.from, () => each.to);
  }
  return text;
}

/** The session that ended, or null for any other payload. */
export function sessionEndOf(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const hook = payload as Record<string, unknown>;
  if (hook['hook_event_name'] !== EDIT_HOOK_EVENT.SESSION_END) return null;
  const session = hook['session_id'];
  return typeof session === 'string' && session.trim() !== '' ? session : null;
}

/**
 * What the host reads to refuse the write, and the model reads to know why.
 *
 * A refusal the model cannot read is one it retries in a loop, so the holder is
 * named and so is the way forward.
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

/**
 * Takes the lease for one write. Null means go ahead, and a string is the reason
 * the write has to wait.
 */
export async function claimEdit(
  edit: EditIntent,
  leases: SeamLeases,
): Promise<string | null> {
  const refused = await claimEditDetailed(edit, leases);
  return refused === null ? null : refused.reason;
}

/** Why a write has to wait, and the workspace lease in its way where there is one. */
export interface EditRefusal {
  reason: string;
  /** The reason as a person is asked it, without a command to go and type. */
  asked?: string;
  /** The other machine's lease, which the person at this agent can take over. */
  leaseId?: string;
}

/** `claimEdit`, keeping the lease in the way, for a host that can ask its person. */
export async function claimEditDetailed(
  edit: EditIntent,
  leases: SeamLeases,
): Promise<EditRefusal | null> {
  const path = leasePathFor(
    edit.path,
    leases.repositoryRoot,
    edit.cwd ?? leases.repositoryRoot,
  );
  /* Outside the repository, or not a path at all: no lease is invented for it, the
     same answer the shell seam gives. */
  if (path === null) return null;

  /* The file itself, not the directory it lands in. A shell command can create
     siblings nobody named, which is why the shell seam claims the directory; an
     editor's tool names exactly the one file it writes, and claiming its directory
     stopped two sessions working on two different files in one folder. A lease on a
     directory still covers this file, so a shell write and an edit still meet. */
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

/**
 * Permission modes in which Claude Code shows its person the prompt a hook asks for.
 *
 * Only these. In `bypassPermissions` an ask is not honoured and the write would
 * simply go ahead, and `auto` and `dontAsk` are the modes somebody chose so as not
 * to be asked; a flat refusal is the only answer that holds in all three.
 */
const ASKING_MODES: readonly string[] = ['default', 'acceptEdits', 'plan'];

/** Whether this payload came from a session whose person will see a permission prompt. */
export function canAskPerson(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object') return false;
  const mode = (payload as Record<string, unknown>)['permission_mode'];
  return typeof mode === 'string' && ASKING_MODES.includes(mode);
}

/**
 * The question put to the person at the agent, in Claude Code's own prompt.
 *
 * The decision where they already are, rather than a command to go and type: yes
 * and the edit goes ahead, the lines are taken over on the record, and the agent
 * that held them is told; no and the agent is refused as before.
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
