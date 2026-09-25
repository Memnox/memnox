/**
 * A question Memnox put through the agent's own permission prompt, and the person's answer.
 * The host says nothing back when they say yes; the tool simply runs. So the question is
 * kept by its call, and the call returning is read as the yes, learned like any other.
 */
import { userInfo } from 'node:os';

import {
  ACTOR_TYPE,
  canonicalJson,
  DECISION_EFFECT,
  digest,
  ENFORCEMENT_MODE,
  FileGrants,
  grantKeyFor,
  EVENT_SCHEMA_VERSION,
  localRuleRef,
  newEventId,
  openLedger,
  rememberAsk,
  SessionContextStore,
  takeAsk,
  TOOL_CLASS,
  UNNAMED_SESSION,
  type EnforcementMode,
  type EventSink,
  type MemnoxEvent,
  type PendingAsk,
  type ToolClass,
} from '@memnox/core';

import { EDIT_HOST } from './agent-edits';
import { EDIT_HOOK_EVENT } from './edit-hook';
import type { HookAuthorizer } from './hook-authorizer';
import { fieldsOf, sessionOf } from './hook-payload';
import { toolCallOf } from './tool-calls';
import { authorizerFor, readMachineMode, type ToolAnswer } from './tool-hook';
import { ruleOnTool, surfaceOf } from './tool-policy';

/** Who the hook speaks for, and the seams a test replaces. */
interface PromptAnswerDeps {
  home: string;
  agent: string;
  runSession: string | undefined;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  /** Null records nothing. */
  sink?: EventSink | null;
  authorizer?: HookAuthorizer;
  mode?: EnforcementMode;
  /** The person at the keyboard, named in the row; the account name by default. */
  person?: () => string;
}

const TOOL_CLASSES: readonly string[] = Object.values(TOOL_CLASS);
const MODES: readonly string[] = Object.values(ENFORCEMENT_MODE);

/** The call as its host numbers it, or a digest of the tool and what it was given. */
export function toolFingerprint(payload: unknown): string | null {
  const hook = fieldsOf(payload);
  if (hook === null) return null;
  const id = hook['tool_use_id'];
  if (typeof id === 'string' && id !== '') return id;
  const tool = hook['tool_name'];
  if (typeof tool !== 'string') return null;
  return digest(`${tool}\u0000${canonicalJson(hook['tool_input'] ?? null)}`);
}

/**
 * Keeps a question the host is about to put to a person, by its call. Only Claude Code and
 * Codex send the same call again once it ran; elsewhere there is nothing to match it with.
 */
export async function rememberQuestion(
  payload: unknown,
  answer: ToolAnswer,
  deps: PromptAnswerDeps,
): Promise<void> {
  const fingerprint = toolFingerprint(payload);
  if (!answer.asked || fingerprint === null) return;
  if (answer.call.host !== EDIT_HOST.PRE_TOOL_USE) return;
  const { ruling } = answer;
  const ask: PendingAsk = {
    fingerprint,
    at: deps.now().toISOString(),
    tool: answer.call.tool,
    action: ruling.action,
    ...(ruling.target === undefined ? {} : { target: ruling.target }),
    class: ruling.class,
    mode: ruling.mode,
    reason: ruling.reason,
    ...(ruling.rule === undefined ? {} : { rule: ruling.rule }),
  };
  const store = new SessionContextStore(deps.home);
  const session = sessionKey(deps, answer.call.sessionId);
  await store.write(session, rememberAsk(await store.read(session), ask));
}

/**
 * The tool Memnox asked about ran, so the person said yes: a row naming them, and noticing
 * taught, so the same new thing is not asked again. True when this was such an answer.
 */
export async function learnFromAnswer(
  payload: unknown,
  deps: PromptAnswerDeps,
): Promise<boolean> {
  const hook = fieldsOf(payload);
  const fingerprint = toolFingerprint(payload);
  if (hook === null || fingerprint === null) return false;
  if (hook['hook_event_name'] !== EDIT_HOOK_EVENT.POST_TOOL_USE) return false;
  const store = new SessionContextStore(deps.home);
  const session = sessionKey(deps, sessionOf(hook));
  const taken = takeAsk(await store.read(session), fingerprint, deps.now().toISOString());
  if (taken.ask === null) return false;
  await store.write(session, taken.state);
  await recordYes(taken.ask, session, deps);
  await countYes(taken.ask, session, deps.home);
  await teachNotice(hook, deps).catch(() => undefined);
  return true;
}

/**
 * Counted toward the session's grants, so the second yes to the same action is the last
 * one anybody is asked for. Best effort, since the tool already ran.
 */
async function countYes(ask: PendingAsk, sessionId: string, home: string): Promise<void> {
  await new FileGrants(home)
    .approved({
      sessionId,
      operation: grantKeyFor(ask.action, ask.target),
      fingerprint: ask.target ?? ask.action,
      class: ask.class,
    })
    .catch(() => undefined);
}

/** The same call ruled on again in this process, so noticing holds the question, then the yes. */
async function teachNotice(
  hook: Record<string, unknown>,
  deps: PromptAnswerDeps,
): Promise<void> {
  const before = { ...hook, hook_event_name: EDIT_HOOK_EVENT.PRE_TOOL_USE };
  const call = toolCallOf(before, deps.home);
  if (call === null) return;
  const authorizer =
    deps.authorizer ?? (await authorizerFor({ ...deps, personThere: true }));
  const mode = deps.mode ?? (await readMachineMode(deps.home));
  await ruleOnTool(call, { authorizer, mode, env: deps.env });
  authorizer.personAllowed();
}

/** Best effort: the tool already ran, and a lost row is not worth interrupting anybody for. */
async function recordYes(
  ask: PendingAsk,
  sessionId: string,
  deps: PromptAnswerDeps,
): Promise<void> {
  const sink = deps.sink === undefined ? openLedger(deps.home) : deps.sink;
  if (sink === null) return;
  try {
    await sink.append(yesRow(ask, sessionId, deps));
  } catch {
    // Nothing to do about a lost row here.
  }
}

function yesRow(ask: PendingAsk, sessionId: string, deps: PromptAnswerDeps): MemnoxEvent {
  const person = personOf(deps);
  return {
    id: newEventId(),
    schemaVersion: EVENT_SCHEMA_VERSION,
    at: deps.now().toISOString(),
    sessionId,
    agent: deps.agent,
    actorType: ACTOR_TYPE.HUMAN,
    principal: person,
    surface: surfaceOf(ask.action),
    operation: ask.action,
    class: classOf(ask.class),
    effect: DECISION_EFFECT.ALLOW,
    mode: modeOf(ask.mode),
    reason: `${person} said yes in ${deps.agent}'s own prompt to what Memnox asked: ${ask.reason} (${ask.tool})`,
    // A digest of what was named, never the input: a row carries names, not contents.
    argsDigest: digest(ask.target ?? ask.tool),
    ...(ask.target === undefined ? {} : { target: ask.target }),
    ...(ask.rule === undefined ? {} : { rule: localRuleRef(ask.rule) }),
    authorizedBy: `${person} (${deps.agent} prompt)`,
  };
}

/** Only enforce puts a question, so a mode this does not know is read as enforce. */
function modeOf(mode: string): EnforcementMode {
  // Checked against the modes on the line above, so the cast names one of them.
  return MODES.includes(mode) ? (mode as EnforcementMode) : ENFORCEMENT_MODE.ENFORCE;
}

/** A class the ledger does not know is recorded as unknown, never as a safe one. */
function classOf(value: string): ToolClass {
  // Checked against the classes on the line above, so the cast names one of them.
  return TOOL_CLASSES.includes(value) ? (value as ToolClass) : TOOL_CLASS.UNKNOWN;
}

function personOf(deps: PromptAnswerDeps): string {
  try {
    return (deps.person ?? ((): string => userInfo().username))();
  } catch {
    // An account with no name is still a person at the keyboard.
    return 'a person';
  }
}

/** The session `memnox run` set, then the host's own, the way every row here is filed. */
function sessionKey(deps: PromptAnswerDeps, hostSession: string): string {
  return deps.runSession ?? (hostSession === '' ? UNNAMED_SESSION : hostSession);
}
