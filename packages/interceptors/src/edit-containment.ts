/**
 * The repository boundary and probation, for an editor's own file tools: a write outside
 * the session's repository, or any write by an agent still on probation, is put to the
 * person where the host can ask one, and refused in the host's own words where it cannot.
 */
import { isAbsolute, resolve } from 'node:path';

import {
  ACTION,
  containmentAsk,
  ENFORCEMENT_MODE,
  SESSION_VAR,
  type ContainmentAsk,
} from '@memnox/core';

import { EDIT_HOST, type AgentEdits, type EditHost } from './agent-edits';
import { containmentFor } from './containment-loader';
import type { EditHookContext } from './edit-claims';
import { EDIT_HOOK_EVENT } from './edit-hook';
import { readMachineMode } from './tool-hook';

/** What a refused agent is told, since a yes in chat never reaches this hook and a detour is the same write. */
export const NOT_FROM_CHAT =
  'A yes in the conversation cannot allow this, because Memnox never sees it, and making the same write another way, such as through the shell, is the same write. Tell your person it was held and why.';

/** The way through that actually reaches Memnox, where the host has a prompt to show. */
const CLAUDE_WAY =
  'They can allow it by switching Claude Code to a mode that shows permission prompts, such as default, and asking again, or make the change themselves.';

const OTHER_WAY = 'They can make the change themselves.';

/** The reply that holds this write back, or null where containment has nothing to say. */
export async function containedEdit(
  found: AgentEdits,
  asking: boolean,
  context: EditHookContext,
  // Injected so a test states the repository rather than asking git.
  rootOf?: (cwd: string) => string | null,
): Promise<string | null> {
  // Watching stops nothing: a fresh machine is in observe, and every other seam lets it through.
  if ((await readMachineMode(context.home)) !== ENFORCEMENT_MODE.ENFORCE) return null;
  for (const edit of found.edits) {
    const cwd = edit.cwd ?? context.cwd;
    const containment = await containmentFor({
      home: context.home,
      env: context.runSession === undefined ? {} : { [SESSION_VAR]: context.runSession },
      cwd,
      now: context.now(),
      agent: context.agent,
      ...(rootOf === undefined ? {} : { rootOf }),
    });
    if (containment === null) continue;
    const file = isAbsolute(edit.path) ? edit.path : resolve(cwd, edit.path);
    const asked = containmentAsk(
      { action: ACTION.FILESYSTEM_WRITE, target: file },
      containment,
    );
    if (asked !== null) return replyFor(found.host, asked, asking);
  }
  return null;
}

/** Claude Code puts an ask to its person; every other host is refused with the reason. */
function replyFor(host: EditHost, asked: ContainmentAsk, asking: boolean): string {
  if (host === EDIT_HOST.PRE_TOOL_USE) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: EDIT_HOOK_EVENT.PRE_TOOL_USE,
        permissionDecision: asking ? 'ask' : 'deny',
        permissionDecisionReason: asking
          ? asked.reason
          : `${asked.reason} ${NOT_FROM_CHAT} ${CLAUDE_WAY}`,
      },
    });
  }
  const told = `${asked.reason} ${NOT_FROM_CHAT} ${OTHER_WAY}`;
  if (host === EDIT_HOST.GEMINI)
    return JSON.stringify({ decision: 'deny', reason: told });
  if (host === EDIT_HOST.WINDSURF) return told;
  return JSON.stringify({
    permission: 'deny',
    user_message: asked.reason,
    agent_message: told,
  });
}
