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
  APPROVAL_ROUTE,
  holdInChat,
  HOLD_ANSWER,
  openQuestionFor,
  PendingApprovals,
  type ApprovalRoute,
  type ChatQuestion,
  type PendingApproval,
} from '@memnox/core';

import { HookAuthorizer } from './hook-authorizer';
import { readHookConfig } from './hook-config';
import { loadHookGate } from './hook-gate-loader';
import { toolCallOf, type ToolCall } from './tool-calls';
import { reportToDaemon } from './daemon-client';
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
  route?: ApprovalRoute;
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
  const found = toolCallOf(payload, context.home);
  if (found === null) return null;
  const mode = seams.mode ?? (await readMachineMode(context.home));
  // Off means nothing is ruled on or recorded, which is what somebody turning it off wants.
  if (mode === ENFORCEMENT_MODE.OFF) return null;
  const route = seams.route ?? (await readApprovalRoute(context.home));
  // A person who wants questions in their DM wants them there, not in a prompt here.
  const call = route === APPROVAL_ROUTE.DM ? { ...found, nativeAsk: false } : found;

  const authorizer = seams.authorizer ?? (await authorizerFor(context, call.sessionId));
  const ruled = await ruleOnTool(call, {
    authorizer,
    mode,
    env: context.env,
    home: context.home,
  });
  const sessionId = sessionFor(call, context);
  const granted = await withSessionGrant(ruled, sessionId, context.home);
  const ruling = await withChatAnswer(granted, sessionId, context);
  // The breaker counts drift for a session only the hooks see, which reports nothing else.
  if (ruling.effect === DECISION_EFFECT.ALLOW && ruling.outOfScope === true) {
    await reportToDaemon(context.home, {
      action: ruling.action,
      ...(ruling.target === undefined ? {} : { target: ruling.target }),
      sessionId: sessionFor(call, context),
      outOfScope: true,
      driftOnly: true,
    }).catch(() => null);
  }
  if (isWorthRecording(ruling)) {
    const sink = seams.sink === undefined ? openLedger(context.home) : seams.sink;
    await keep(sink, call, ruling, context);
  }
  const asked = putsQuestion(call, ruling, context.personThere);
  const held =
    ruling.effect === DECISION_EFFECT.ASK && !asked
      ? await heldFor(ruling, sessionId, route, context)
      : null;
  return {
    call,
    ruling,
    reply: toolReply(call, ruling, context.personThere, held),
    asked,
  };
}

/** Where questions go, from `config.toml`; in the session where nothing says otherwise. */
export async function readApprovalRoute(home: string): Promise<ApprovalRoute> {
  try {
    return parseConfig(await readFile(configPathFor(home), 'utf8')).approvals;
  } catch {
    return APPROVAL_ROUTE.SESSION;
  }
}

/** The question written down for a person, or null where it could not be, which refuses as before. */
async function heldFor(
  ruling: ToolRuling,
  sessionId: string,
  route: ApprovalRoute,
  context: ToolHookContext,
): Promise<PendingApproval | null> {
  const question = questionOf(ruling, sessionId, context.agent);
  return holdInChat(
    new PendingApprovals(context.home),
    question,
    route,
    context.now().toISOString(),
  ).catch(() => null);
}

/**
 * The retry after a person answered a held question: a yes lets it through, "for this
 * session" stops the asking, and a no refuses it with their word rather than a rule's.
 */
async function withChatAnswer(
  ruling: ToolRuling,
  sessionId: string,
  context: ToolHookContext,
): Promise<ToolRuling> {
  if (ruling.effect !== DECISION_EFFECT.ASK) return ruling;
  const approvals = new PendingApprovals(context.home);
  const question = questionOf(ruling, sessionId, context.agent);
  const held = await openQuestionFor(
    approvals,
    question,
    context.now().toISOString(),
  ).catch(() => null);
  if (held?.answer === undefined) return ruling;
  await approvals.clear(held.id).catch(() => undefined);
  const by = held.answeredBy ?? 'a person';
  if (held.answer === HOLD_ANSWER.SESSION)
    await grantSession(ruling, sessionId, context.home);
  if (held.answer === HOLD_ANSWER.ONCE || held.answer === HOLD_ANSWER.SESSION) {
    return {
      ...ruling,
      effect: DECISION_EFFECT.ALLOW,
      reason: `${by} allowed this (${held.id})`,
    };
  }
  return {
    ...ruling,
    effect: DECISION_EFFECT.DENY,
    reason: `${by} said no to this (${held.id})`,
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

/** What a held question is about, from the ruling that raised it. */
function questionOf(ruling: ToolRuling, sessionId: string, agent: string): ChatQuestion {
  return {
    sessionId,
    agent,
    action: ruling.action,
    ...(ruling.target === undefined ? {} : { target: ruling.target }),
    class: ruling.class,
    reason: ruling.reason,
  };
}

/** "For this session", kept where the next call looks for it. Best effort, like every grant. */
async function grantSession(
  ruling: ToolRuling,
  sessionId: string,
  home: string,
): Promise<void> {
  await new FileGrants(home)
    .grant({
      sessionId,
      operation: grantKeyFor(ruling.action, ruling.target),
      fingerprint: ruling.target ?? ruling.action,
      class: ruling.class,
    })
    .catch(() => undefined);
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
export async function authorizerFor(
  context: ToolHookContext,
  hostSessionId?: string,
): Promise<HookAuthorizer> {
  const config = await readHookConfig(context.env, context.home);
  const gate = await loadHookGate(
    {
      ...config,
      agentName: context.agent,
      ...(hostSessionId === undefined || hostSessionId === '' ? {} : { hostSessionId }),
    },
    context.home,
  );
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
