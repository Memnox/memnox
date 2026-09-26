import { homedir } from 'node:os';

import {
  desktopNotice,
  AGENT_FLAG,
  CloudLeases,
  DECISION_EFFECT,
  ENV_AGENT_NAME,
  LeaseRegistry,
  protectionStopped,
  SESSION_VAR,
} from '@memnox/core';

import {
  agentEditsOf,
  CURSOR_EVENT,
  EDIT_HOST,
  EDIT_MOMENT,
  endedSessionOf,
  type AgentEdits,
} from './agent-edits';
import { claimAll, type EditHookContext } from './edit-claims';
import { checkpointBeforeFirstWrite } from './checkpoint-seam';
import { canAskPerson } from './edit-hook';
import { fieldsOf } from './hook-payload';
import { answerPause } from './edit-pause';
import { keepSessionSummary } from './session-summary-row';
import { answeredSessionStart, beforePause, replyInSession } from './in-session';
import { log, readStdin } from './seam-runtime';
import { sessionEventOf } from './session-events';
import { answerToolCall, failedToolAnswer, type ToolAnswer } from './tool-hook';
import { DEFAULT_AGENT_NAME, TOOL_POLICY_FLAG } from './tool-hook.constants';
import type { ToolReply } from './tool-policy';

/**
 * The hook an editor runs before a tool call and when a session ends: with `--policy` it
 * rules on the call, and it takes a lease before a write. Silent and exit zero means go
 * ahead, which is also what anything unreadable gets.
 */

/** The exit code Windsurf reads as "blocked", with the reason on stderr. */
const WINDSURF_BLOCK = 2;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const context = contextFrom(args, process.env);
  let payload: unknown;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    // Not a payload this hook was written for, so it says nothing about it.
    return;
  }

  const ended = endedSessionOf(payload);
  if (ended !== null) return releaseSession(ended, context);
  // Stopped on purpose: no rule, lease or pause stands in the way until `memnox start`.
  if (await protectionStopped(context.home)) return;
  if (await answeredSessionStart(payload, context, process.env)) return;

  // The rules first, so nothing takes a lease on a write it was never allowed to make.
  const ruled = args.includes(TOOL_POLICY_FLAG)
    ? await answerPolicy(payload, context)
    : null;
  if (ruled !== null && ruled.ruling.effect === DECISION_EFFECT.DENY)
    return emit(ruled.reply);
  const reply =
    ruled === null ? null : await replyInSession(payload, ruled, context, process.env);

  // Windsurf's `post_write_code` is both an edit to
  // claim and a tool to record, so the claim goes first.
  const pause = sessionEventOf(payload);
  if (await answerEdits(payload, context)) return;
  emit(reply);
  if (pause === null) return;
  const said = await beforePause(payload, pause, context, process.env);
  process.stdout.write(await answerPause(pause, context, said));
}

/**
 * The rules on this tool call. A failure in observe rules on nothing, as the lease half
 * does, because a hook that refuses everything while only watching gets taken out.
 */
async function answerPolicy(
  payload: unknown,
  context: EditHookContext,
): Promise<ToolAnswer | null> {
  try {
    return await answerToolCall(payload, {
      home: context.home,
      agent: context.agent,
      runSession: context.runSession,
      env: process.env,
      personThere: personThere(payload, context.agent),
      now: context.now,
    });
  } catch (err) {
    log(`tool policy failed: ${String(err)}`);
    // Observe lets it through as before; enforce refuses, since a broken check is not a yes.
    return failedToolAnswer(payload, context.home).catch(() => null);
  }
}

/** Cursor shows its prompt before a command or an MCP call; Claude Code does when attended. */
const CURSOR_ASKING: readonly unknown[] = [
  CURSOR_EVENT.BEFORE_SHELL,
  CURSOR_EVENT.BEFORE_MCP,
];

function personThere(payload: unknown, agent: string): boolean {
  const hook = fieldsOf(payload);
  if (hook !== null && CURSOR_ASKING.includes(hook['hook_event_name'])) return true;
  return agent === DEFAULT_AGENT_NAME && canAskPerson(payload);
}

function emit(reply: ToolReply | null): void {
  if (reply === null) return;
  if (reply.stdout !== undefined) process.stdout.write(`${reply.stdout}\n`);
  if (reply.stderr !== undefined) process.stderr.write(`${reply.stderr}\n`);
  if (reply.exitCode !== undefined) process.exitCode = reply.exitCode;
}

/**
 * Which agent this hook speaks for: the environment
 * `memnox run` sets, then its own `--agent` flag.
 */
function contextFrom(args: readonly string[], env: NodeJS.ProcessEnv): EditHookContext {
  return {
    home: homedir(),
    agent: env[ENV_AGENT_NAME] ?? agentFlag(args) ?? DEFAULT_AGENT_NAME,
    runSession: env[SESSION_VAR],
    pid: process.pid,
    cwd: process.cwd(),
    now: () => new Date(),
  };
}

/** `--agent cursor`, where the installed command names one. */
function agentFlag(args: readonly string[]): string | null {
  const at = args.indexOf(AGENT_FLAG);
  if (at === -1) return null;
  const value = args[at + 1];
  return value === undefined || value.startsWith('-') ? null : value;
}

/**
 * Everything the session held, here and in the workspace,
 * let go at once so nobody waits out a window.
 */
async function releaseSession(ended: string, context: EditHookContext): Promise<void> {
  await new LeaseRegistry(context.home).releaseSession(
    ended,
    context.now().toISOString(),
  );
  await new CloudLeases(context.home).releaseSession({
    agent: context.agent,
    sessionId: context.runSession ?? ended,
    pid: context.pid,
  });
  // A session `memnox run` started is summed up when it exits, on the terminal.
  if (context.runSession === undefined) {
    const line = await keepSessionSummary(context.home, ended, context.now());
    // On the screen as well, since a session ending has nobody watching its terminal.
    if (line !== null) desktopNotice(line);
  }
}

/**
 * Claims the writes in this payload and answers
 * the host. True when the write was refused.
 */
async function answerEdits(payload: unknown, context: EditHookContext): Promise<boolean> {
  const found = agentEditsOf(payload);
  if (found === null) return false;
  const refusal = await claimAll(found, canAskPerson(payload), context);
  if (refusal === null) {
    await keepBeforeFirstWrite(found, context);
    // Cursor reads a permission reply that is not JSON
    // as a block, so an allow is an empty object.
    if (found.host === EDIT_HOST.CURSOR && found.moment === EDIT_MOMENT.BEFORE) {
      process.stdout.write('{}\n');
    }
    return false;
  }
  // Windsurf reads a refusal from stderr on exit code 2; every other host reads stdout.
  if (found.host === EDIT_HOST.WINDSURF) {
    process.stderr.write(`${refusal}\n`);
    process.exitCode = WINDSURF_BLOCK;
  } else {
    process.stdout.write(`${refusal}\n`);
  }
  return true;
}

/**
 * The tree as it was before this session's first write, taken while the write
 * still waits on this hook. An edit already on disk is too late to keep.
 */
async function keepBeforeFirstWrite(
  found: AgentEdits,
  context: EditHookContext,
): Promise<void> {
  const [edit] = found.edits;
  if (edit === undefined || found.moment !== EDIT_MOMENT.BEFORE) return;
  await checkpointBeforeFirstWrite({
    home: context.home,
    sessionId: context.runSession ?? edit.sessionId,
    agent: context.agent,
    place: edit.cwd ?? context.cwd,
    now: context.now,
    log,
  });
}

main().catch((err: unknown) => {
  // A hook that throws must not read as a refusal; it ruled on nothing and says so.
  log(`edit hook failed, ruling on nothing: ${String(err)}`);
});
