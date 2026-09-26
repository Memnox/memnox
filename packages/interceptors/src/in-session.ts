/**
 * What the editor hook says inside the session beyond a verdict: the boundary at its start,
 * a decision already taken where the agent meets it, and a person's yes learned from the
 * agent's own prompt. Every part is best effort, since none of it may stop the agent.
 */
import { DECISION_EFFECT, SessionTasks, TASK_INTENT, taskFromPrompt } from '@memnox/core';

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
import { authorizerFor, type ToolAnswer } from './tool-hook';
import { taintFromResult } from './result-taint';
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

/** Best effort: the tool already ran, and a mark that failed is a quieter session, not a stop. */
async function markIfInstructed(
  payload: unknown,
  context: EditHookContext,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    const authorizer = await authorizerFor({
      home: context.home,
      agent: context.agent,
      runSession: context.runSession,
      env,
      personThere: true,
      now: context.now,
    });
    taintFromResult(payload, authorizer);
  } catch (err) {
    log(`reading a tool result failed: ${String(err)}`);
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
      await markIfInstructed(payload, context, env);
      return null;
    }
    if (pause.moment !== SESSION_MOMENT.PROMPT || pause.prompt === undefined) return null;
    const sessionId = context.runSession ?? pause.sessionId;
    const noted = await taskOfPrompt(
      context.home,
      sessionId,
      pause.prompt,
      context.now(),
    );
    const lookup = { sessionId, prompt: pause.prompt };
    const decided = await decisionsAt(
      pause.cwd === undefined ? lookup : { ...lookup, cwd: pause.cwd },
      depsOf(context, env),
    );
    const said = [noted, decided].filter((each): each is string => each !== null);
    return said.length === 0 ? null : said.join('\n');
  } catch (err) {
    log(`session context failed at a pause: ${String(err)}`);
    return null;
  }
}

/**
 * The prompt kept as the session's task, so `why` quotes it and an investigation is held to
 * reading, and what the agent is told when it reads as one. Null when there is nothing to say.
 */
async function taskOfPrompt(
  home: string,
  sessionId: string,
  prompt: string,
  now: Date,
): Promise<string | null> {
  if (sessionId === '') return null;
  const tasks = new SessionTasks(home);
  const task = taskFromPrompt(prompt, await tasks.read(sessionId), {
    sessionId,
    now: now.toISOString(),
  });
  if (task === null) return null;
  await tasks.declare(task);
  return task.intent === TASK_INTENT.INVESTIGATE ? INVESTIGATION_NOTE : null;
}

/** Said to the agent when the ask reads as an investigation, so a refusal is no surprise. */
const INVESTIGATION_NOTE =
  'Memnox read this ask as an investigation: read anything you need, and nothing outside this machine is changed. If the person wants a change, they will ask for one.';

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
