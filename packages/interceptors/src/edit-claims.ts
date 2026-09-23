import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

import {
  CloudLeases,
  upcomingRegion,
  WHOLE_FILE,
  type WrittenRegion,
} from '@memnox/core';

import {
  agentDenial,
  beforeEdit,
  EDIT_HOST,
  EDIT_MOMENT,
  type AgentEdits,
} from './agent-edits';
import {
  afterEdit,
  claimEdit,
  EDIT_HOOK_EVENT,
  EDIT_HOOK_WAIT_MS,
  EDIT_TOOLS,
  editAsk,
  editOf,
  type EditRefusal,
} from './edit-hook';
import { containedEdit } from './edit-containment';
import { takeTakeover, writeTakeover } from './edit-marks';
import type { EditIntent } from './hook-payload';
import { buildLeases } from './seam-runtime';
import type { SessionEvent } from './session-events';
import { DEFAULT_AGENT_NAME } from './tool-hook.constants';

/**
 * The edit hook's claims: every file a write touches, narrowed to the lines it changes,
 * refused in the host's words, and taken over when the person at the agent said yes.
 */

/** Who the edit hook speaks for, read once where the process starts. */
export interface EditHookContext {
  home: string;
  /** The environment's agent, then the one the hook's command line names. */
  agent: string;
  /** The session `memnox run` set, which holds are filed under where there is one. */
  runSession: string | undefined;
  pid: number;
  cwd: string;
  now: () => Date;
}

/**
 * The refusal to give for this write, in the
 * host's own words, or null where it may go ahead.
 */
export async function claimAll(
  found: AgentEdits,
  personThere: boolean,
  context: EditHookContext,
): Promise<string | null> {
  // Only Claude Code shows its person a prompt a
  // hook asks for; the others are refused flat.
  const asking =
    personThere &&
    found.host === EDIT_HOST.PRE_TOOL_USE &&
    context.agent === DEFAULT_AGENT_NAME;
  const before = found.moment === EDIT_MOMENT.BEFORE;
  // The boundary before any lease, so nothing is held for a write that has to ask first.
  const contained = before ? await containedEdit(found, asking, context) : null;
  if (contained !== null) return contained;
  for (const edit of found.edits) {
    // A Cursor write naming no change would claim the
    // whole file; `afterFileEdit` claims its lines.
    if (found.host === EDIT_HOST.CURSOR && before && edit.change === undefined) continue;
    const refused = await claimOne(edit, !before, context);
    // An edit already written cannot be refused, but
    // its lines are still held against other machines.
    if (refused === null || !before) continue;
    if (asking && refused.leaseId !== undefined) {
      await writeTakeover(
        context.home,
        { sessionId: edit.sessionId, file: fileOf(edit, context) },
        refused.leaseId,
      );
      return editAsk(refused.asked ?? refused.reason);
    }
    return agentDenial(found.host, refused.reason);
  }
  return null;
}

/** Takes the lease for one write, narrowed to the lines it changes. */
async function claimOne(
  edit: EditIntent,
  written: boolean,
  context: EditHookContext,
): Promise<EditRefusal | null> {
  const leases = buildLeases(edit.cwd ?? context.cwd, {
    sessionId: edit.sessionId,
    waitMs: EDIT_HOOK_WAIT_MS,
    agent: context.agent,
    // Read from the edit itself: two agents in one file only meet where their edits do.
    region: () => (written ? regionWritten(edit, context) : regionOfEdit(edit, context)),
  });
  if (leases === undefined) return null;
  return claimEdit(edit, leases);
}

/**
 * An edit the person allowed has landed: take the other
 * agent's lines over on the record, and claim them.
 */
export async function takeOverIfAllowed(
  pause: SessionEvent,
  context: EditHookContext,
): Promise<void> {
  if (pause.tool === undefined || !EDIT_TOOLS.includes(pause.tool)) return;
  const intent = editOf({
    hook_event_name: EDIT_HOOK_EVENT.PRE_TOOL_USE,
    tool_name: pause.tool,
    session_id: pause.sessionId,
    ...(pause.cwd === undefined ? {} : { cwd: pause.cwd }),
    tool_input: pause.input ?? {},
  });
  if (intent === null) return;
  const edit = { sessionId: intent.sessionId, file: fileOf(intent, context) };
  const leaseId = await takeTakeover(context.home, edit, context.now().getTime());
  if (leaseId === null) return;

  const { agent, home } = context;
  const holder = {
    agent,
    sessionId: context.runSession ?? intent.sessionId,
    pid: context.pid,
  };
  const why = `the person at ${agent} on ${hostname()} chose to take these lines over`;
  await new CloudLeases(home).free(leaseId, holder, why).catch(() => undefined);
  await claimOne(intent, true, context);
}

function fileOf(edit: EditIntent, context: EditHookContext): string {
  return isAbsolute(edit.path) ? edit.path : resolve(edit.cwd ?? context.cwd, edit.path);
}

/** What an edit already on disk changed, found by taking it back out. */
async function regionWritten(
  edit: EditIntent,
  context: EditHookContext,
): Promise<WrittenRegion> {
  const change = edit.change;
  if (change === undefined) return WHOLE_FILE;
  const file = fileOf(edit, context);
  const after = await readOrNull(file);
  const before = after === null ? null : beforeEdit(after, change);
  if (after === null || before === null) return WHOLE_FILE;
  return upcomingRegion(file, before, after);
}

/** What this edit touches, or the whole file wherever that cannot be told. */
async function regionOfEdit(
  edit: EditIntent,
  context: EditHookContext,
): Promise<WrittenRegion> {
  const change = edit.change;
  if (change === undefined) return WHOLE_FILE;
  const file = fileOf(edit, context);
  // A new file has nothing to be narrower than: all of it is being written.
  const before = await readOrNull(file);
  const after = before === null ? null : afterEdit(before, change);
  if (before === null || after === null) return WHOLE_FILE;
  return upcomingRegion(file, before, after);
}

async function readOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}
