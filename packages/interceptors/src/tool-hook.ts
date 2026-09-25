import { readFile } from 'node:fs/promises';

import {
  configPathFor,
  DECISION_EFFECT,
  ENFORCEMENT_MODE,
  FIRST_RUN_MODE,
  openLedger,
  overlaysInForce,
  parseConfig,
  protectionStopped,
  provenanceOf,
  TOOL_CLASS,
  UNNAMED_SESSION,
  type EnforcementMode,
  type EventSink,
  FileGrants,
  grantKeyFor,
} from '@memnox/core';

import { HookAuthorizer } from './hook-authorizer';
import { readHookConfig } from './hook-config';
import { loadHookGate } from './hook-gate-loader';
import { toolCallOf, type ToolCall } from './tool-calls';
import {
  isWorthRecording,
  putsQuestion,
  refusedUnasked,
  ruleOnTool,
  toolEventFor,
  toolReply,
  type ToolReply,
  type ToolRuling,
} from './tool-policy';

/**
 * The editor hook's policy half, as one process sees it: the rules the registry names,
 * the machine's mode from `config.toml`, the verdict in the host's words, and one row.
 * No daemon round trip, because the verdict needs the rule's name and the arguments.
 */

/** Who the hook speaks for and where, read once where the process starts. */
export interface ToolHookContext {
  home: string;
  /** The agent the hook's command names, or the one `memnox run` set. */
  agent: string;
  /** The session `memnox run` set, which a row is filed under where there is one. */
  runSession: string | undefined;
  env: NodeJS.ProcessEnv;
  /** True where the host will show a person the question an `ask` puts. */
  personThere: boolean;
  now: () => Date;
}

/** Injected by tests; each falls back to what the process would build for itself. */
export interface ToolHookSeams {
  authorizer?: HookAuthorizer;
  mode?: EnforcementMode;
  /** Null records nothing. */
  sink?: EventSink | null;
}

/** What the hook decided, and what it says to the host, or null for no reply. */
export interface ToolAnswer {
  call: ToolCall;
  ruling: ToolRuling;
  reply: ToolReply | null;
  /** True where the host puts the question to a person, whose yes the tool running is. */
  asked: boolean;
}

/**
 * The mode `memnox protect --enforce` wrote, read and never created, and off while
 * `memnox stop` holds, since a stop is off with the mode kept for `start` to return to.
 */
export async function readMachineMode(home: string): Promise<EnforcementMode> {
  if (await protectionStopped(home)) return ENFORCEMENT_MODE.OFF;
  try {
    return parseConfig(await readFile(configPathFor(home), 'utf8')).mode;
  } catch {
    // No settings yet is the first run, which observes before it enforces.
    return FIRST_RUN_MODE;
  }
}

/** Rules on the tool call in this payload, and records it. Null where there is none. */
export async function answerToolCall(
  payload: unknown,
  context: ToolHookContext,
  seams: ToolHookSeams = {},
): Promise<ToolAnswer | null> {
  const call = toolCallOf(payload, context.home);
  if (call === null) return null;
  const mode = seams.mode ?? (await readMachineMode(context.home));
  // Off means nothing is ruled on or recorded, which is what somebody turning it off wants.
  if (mode === ENFORCEMENT_MODE.OFF) return null;

  const authorizer = seams.authorizer ?? (await authorizerFor(context));
  const ruled = await ruleOnTool(call, {
    authorizer,
    mode,
    env: context.env,
    home: context.home,
  });
  const ruling = await withSessionGrant(ruled, sessionFor(call, context), context.home);
  if (isWorthRecording(ruling)) {
    const sink = seams.sink === undefined ? openLedger(context.home) : seams.sink;
    await keep(sink, call, ruling, context);
  }
  return {
    call,
    ruling,
    reply: toolReply(call, ruling, context.personThere),
    asked: putsQuestion(call, ruling, context.personThere),
  };
}

/**
 * An ask a person already answered in this session, twice or "for this session", is let
 * through rather than put to them again. Only an ask: a refusal is never granted around.
 */
async function withSessionGrant(
  ruling: ToolRuling,
  sessionId: string,
  home: string,
): Promise<ToolRuling> {
  if (ruling.effect !== DECISION_EFFECT.ASK) return ruling;
  const covered = await new FileGrants(home)
    .covers({
      sessionId,
      operation: grantKeyFor(ruling.action, ruling.target),
      fingerprint: ruling.target ?? ruling.action,
      class: ruling.class,
    })
    .catch(() => false);
  if (!covered) return ruling;
  return {
    ...ruling,
    effect: DECISION_EFFECT.ALLOW,
    reason: `a person already allowed ${ruling.action} in this session`,
  };
}

/** The session `memnox run` set, then the host's own, the way every row here is filed. */
export function sessionFor(
  call: ToolCall,
  context: Pick<ToolHookContext, 'runSession'>,
): string {
  return context.runSession ?? (call.sessionId === '' ? UNNAMED_SESSION : call.sessionId);
}

/** Said when the rules could not be read, so a person knows the refusal is ours and why. */
const NOT_RULED =
  'the rules on this machine could not be checked, and it is in enforce, so nothing runs unchecked. "memnox doctor --wiring" says what is wrong.';

/**
 * What a hook says when ruling threw. In enforce it refuses, because a person who turned
 * enforcement on asked to be stopped rather than waved through by a broken check; in any
 * other mode it says nothing, since observing never stopped anything to begin with.
 */
export async function failedToolAnswer(
  payload: unknown,
  home: string,
): Promise<ToolAnswer | null> {
  if ((await readMachineMode(home)) !== ENFORCEMENT_MODE.ENFORCE) return null;
  const call = toolCallOf(payload, home);
  if (call === null) return null;
  const first = call.requests[0];
  const ruling: ToolRuling = {
    action: first === undefined ? call.tool : first.action,
    class: first === undefined ? TOOL_CLASS.UNKNOWN : first.class,
    effect: DECISION_EFFECT.DENY,
    mode: ENFORCEMENT_MODE.ENFORCE,
    reason: NOT_RULED,
  };
  return { call, ruling, reply: toolReply(call, ruling, false), asked: false };
}

/** The same gate every seam loads, evaluated as the agent the hook was installed for. */
export async function authorizerFor(context: ToolHookContext): Promise<HookAuthorizer> {
  const config = await readHookConfig(context.env, context.home);
  const gate = await loadHookGate({ ...config, agentName: context.agent }, context.home);
  return new HookAuthorizer(gate === null ? {} : { gate });
}

/** Best effort: the verdict has been reached, and a ledger that stops the agent is removed. */
async function keep(
  sink: EventSink | null,
  call: ToolCall,
  ruling: ToolRuling,
  context: ToolHookContext,
): Promise<void> {
  if (sink === null) return;
  try {
    const at = context.now().toISOString();
    const provenance = await provenanceOf(
      context.home,
      await overlaysInForce(context.home),
      at,
    );
    const sessionId = sessionFor(call, context);
    await sink.append(
      toolEventFor(call, ruling, {
        ...provenance,
        agent: context.agent,
        sessionId,
        at,
        refused: refusedUnasked(call, ruling, context.personThere),
      }),
    );
  } catch {
    // Nothing to do about a lost row here, and nothing worth interrupting the agent for.
  }
}
