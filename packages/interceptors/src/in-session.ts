/**
 * What the editor hook says inside the session beyond a verdict: the boundary at its start,
 * a decision already taken where the agent meets it, and a person's yes learned from the
 * agent's own prompt. Every part is best effort, since none of it may stop the agent.
 */
import { DECISION_EFFECT } from '@memnox/core';

import { EDIT_HOST } from './agent-edits';
import type { EditHookContext } from './edit-claims';
import { log } from './seam-runtime';
import {
  answerSessionStart,
  decisionsAt,
  preToolContext,
  sessionStartOf,
  type SessionContextDeps,
} from './session-context-hook';
import { SESSION_MOMENT, type SessionEvent } from './session-events';
import { learnFromAnswer, rememberQuestion } from './prompt-answers';
import type { ToolAnswer } from './tool-hook';
import { DEFAULT_AGENT_NAME } from './tool-hook.constants';
import type { ToolReply } from './tool-policy';

/** True when this was a session starting, and its boundary has been written out. */
export async function answeredSessionStart(
  payload: unknown,
  context: EditHookContext,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const start = sessionStartOf(payload);
  if (start === null) return false;
  try {
    process.stdout.write(await answerSessionStart(start, depsOf(context, env)));
  } catch (err) {
    log(`session context failed, saying nothing: ${String(err)}`);
  }
  return true;
}

/**
 * The reply for a ruled call: a question kept so its answer can be learned, and an allow
 * that meets a remembered decision carries it as context. Claude Code alone reads that.
 */
export async function replyInSession(
  payload: unknown,
  ruled: ToolAnswer,
  context: EditHookContext,
  env: NodeJS.ProcessEnv,
): Promise<ToolReply | null> {
  try {
    await rememberQuestion(payload, ruled, { ...context, env });
    if (!carriesDecisions(ruled, context)) return ruled.reply;
    const { call, ruling } = ruled;
    const subjects =
      call.requests.length > 0
        ? call.requests
        : [
            {
              action: ruling.action,
              ...(ruling.target === undefined ? {} : { target: ruling.target }),
            },
          ];
    const lookup = { sessionId: context.runSession ?? call.sessionId, subjects };
    const said = await decisionsAt(
      call.cwd === undefined ? lookup : { ...lookup, cwd: call.cwd },
      depsOf(context, env),
    );
    return said === null ? ruled.reply : { stdout: preToolContext(said) };
  } catch (err) {
    log(`session context failed, saying only the verdict: ${String(err)}`);
    return ruled.reply;
  }
}

/**
 * At a pause: a tool Memnox asked about has run, so its yes is learned; a prompt is read for
 * a decision it names, returned to ride beside any note. Null where there is nothing to add.
 */
export async function beforePause(
  payload: unknown,
  pause: SessionEvent,
  context: EditHookContext,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  try {
    if (pause.moment === SESSION_MOMENT.AFTER_TOOL) {
      await learnFromAnswer(payload, { ...context, env });
      return null;
    }
    if (pause.moment !== SESSION_MOMENT.PROMPT || pause.prompt === undefined) return null;
    const lookup = {
      sessionId: context.runSession ?? pause.sessionId,
      prompt: pause.prompt,
    };
    return await decisionsAt(
      pause.cwd === undefined ? lookup : { ...lookup, cwd: pause.cwd },
      depsOf(context, env),
    );
  } catch (err) {
    log(`session context failed at a pause: ${String(err)}`);
    return null;
  }
}

/** Only an allow a rule spoke on can meet a decision, so an ordinary call reads no file. */
function carriesDecisions(ruled: ToolAnswer, context: EditHookContext): boolean {
  return (
    ruled.ruling.effect === DECISION_EFFECT.ALLOW &&
    ruled.ruling.rule !== undefined &&
    ruled.reply === null &&
    ruled.call.host === EDIT_HOST.PRE_TOOL_USE &&
    context.agent === DEFAULT_AGENT_NAME
  );
}

function depsOf(context: EditHookContext, env: NodeJS.ProcessEnv): SessionContextDeps {
  return {
    home: context.home,
    agent: context.agent,
    env,
    cwd: context.cwd,
    now: context.now,
  };
}
