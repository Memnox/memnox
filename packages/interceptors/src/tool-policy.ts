import {
  AGENT_FROZEN_REASON,
  ACTOR_TYPE,
  applyEnforcementMode,
  DECISION_EFFECT,
  describeAlternative,
  digest,
  EVENT_SCHEMA_VERSION,
  EVENT_SURFACE,
  EXECUTION,
  heldText,
  localRuleRef,
  newEventId,
  TOOL_CLASS,
  type Alternative,
  type DecisionEffect,
  type EnforcementMode,
  type EventSurface,
  type MemnoxEvent,
  type PendingApproval,
  type ToolClass,
} from '@memnox/core';

import { EDIT_HOST } from './agent-edits';
import { EDIT_HOOK_EVENT } from './edit-hook';
import type { HookAuthorizer, HookVerdict } from './hook-authorizer';
import { ShellSeam } from './shell-seam';
import type { ToolCall, ToolRequest } from './tool-calls';

/**
 * An agent's own tool call ruled on against the rules every other seam loads, the mode
 * applied, and the verdict said back in that agent's own words. Only a refusal or a
 * question is said: an allow is silence, so the agent's own permission prompt still runs.
 */

/** What the rules said about one tool call, after the machine's mode was applied. */
export interface ToolRuling {
  action: string;
  target?: string;
  class: ToolClass;
  /** What happens: the verdict in enforce, and allow in observe. */
  effect: DecisionEffect;
  /** What enforce would have done, where the mode or an observed rule kept it back. */
  shadowEffect?: DecisionEffect;
  mode: EnforcementMode;
  reason: string;
  rule?: string;
  alternative?: Alternative;
  /** Outside the task the session declared, which the circuit breaker counts. */
  outOfScope?: boolean;
}

export interface ToolPolicyDeps {
  authorizer: HookAuthorizer;
  mode: EnforcementMode;
  env: NodeJS.ProcessEnv;
  /** Where a clone the agent makes is put on probation. Absent, nothing is noted. */
  home?: string;
}

/** Deny beats ask beats allow, so a call is ruled by its worst action and not its last. */
const SEVERITY: Readonly<Record<string, number>> = {
  [DECISION_EFFECT.ALLOW]: 0,
  [DECISION_EFFECT.ASK]: 1,
  [DECISION_EFFECT.DENY]: 2,
};

interface Ruled {
  request: ToolRequest;
  verdict: HookVerdict;
}

/** The ruling on a tool call, through the same gate and shell classifier every seam uses. */
export async function ruleOnTool(
  call: ToolCall,
  deps: ToolPolicyDeps,
): Promise<ToolRuling> {
  const ruled =
    call.shell === undefined
      ? await worstOf(call.requests, deps.authorizer, call.cwd)
      : await ruleOnLine(call, deps);
  // A freeze is a person stopping this agent on purpose, so observe does not soften it.
  const applied =
    ruled.verdict.reason === AGENT_FROZEN_REASON
      ? { effect: ruled.verdict.effect }
      : applyEnforcementMode(ruled.verdict.effect, deps.mode);
  const shadow = applied.shadowEffect ?? ruled.verdict.shadowEffect;
  const { request, verdict } = ruled;
  return {
    action: request.action,
    ...(request.target === undefined ? {} : { target: request.target }),
    class: request.class,
    effect: applied.effect,
    ...(shadow === undefined ? {} : { shadowEffect: shadow }),
    mode: deps.mode,
    reason: verdict.reason,
    ...(verdict.rule === undefined ? {} : { rule: verdict.rule }),
    ...(verdict.alternative === undefined ? {} : { alternative: verdict.alternative }),
    ...(verdict.outOfScope === true ? { outOfScope: true } : {}),
  };
}

async function worstOf(
  requests: readonly ToolRequest[],
  authorizer: HookAuthorizer,
  workingDirectory?: string,
): Promise<Ruled> {
  let worst: Ruled | null = null;
  for (const request of requests) {
    const verdict = await authorizer.authorize({
      action: request.action,
      toolClass: request.class,
      ...(request.target === undefined ? {} : { target: request.target }),
      ...(request.arguments === undefined ? {} : { arguments: request.arguments }),
      ...(request.environment === undefined ? {} : { environment: request.environment }),
      // Where the agent works, so a rule about `{workspace}` can tell inside from outside.
      ...(workingDirectory === undefined ? {} : { workingDirectory }),
    });
    const next = {
      request,
      verdict:
        request.environment === undefined
          ? verdict
          : { ...verdict, environment: request.environment },
    };
    if (worst === null || severityOf(next) > severityOf(worst)) worst = next;
  }
  // A call is only built with at least one request, so this is the unreachable case.
  if (worst === null) throw new Error('a tool call with nothing to rule on');
  return worst;
}

function severityOf(ruled: Ruled): number {
  return SEVERITY[ruled.verdict.effect] ?? 0;
}

/**
 * A command line through the shell seam with nobody to ask and no lease to take, so
 * `git push --force` inside an agent's own shell tool meets the same rule as on PATH.
 */
async function ruleOnLine(call: ToolCall, deps: ToolPolicyDeps): Promise<Ruled> {
  const seam = new ShellSeam({
    authorizer: deps.authorizer,
    env: deps.env,
    ...(call.cwd === undefined ? {} : { workingDirectory: call.cwd }),
    ...(deps.home === undefined ? {} : { home: deps.home }),
  });
  const { decision } = await seam.gate([call.shell ?? '']);
  return {
    request: {
      action: decision.action,
      ...(decision.target === undefined ? {} : { target: decision.target }),
      class: classOf(decision.class),
    },
    verdict: {
      effect: decision.effect,
      reason: decision.reason,
      ...(decision.rule === undefined ? {} : { rule: decision.rule }),
      ...(decision.alternative === undefined
        ? {}
        : { alternative: decision.alternative }),
      ...(decision.environment === undefined
        ? {}
        : { environment: decision.environment }),
      ...(decision.outOfScope === true ? { outOfScope: true } : {}),
    },
  };
}

const CLASSES: readonly string[] = Object.values(TOOL_CLASS);

/** A class the ledger does not know is recorded as unknown, never as a safe one. */
function classOf(value: string): ToolClass {
  return CLASSES.includes(value) ? (value as ToolClass) : TOOL_CLASS.UNKNOWN;
}

/** Said to the model when its agent has no way to put a question to a person. */
export const NO_WAY_TO_ASK =
  'A person has to allow this, and this agent cannot ask one from its hook, so it was refused. A yes in the conversation cannot allow it, and doing the same thing another way is the same action.';

/** The exit code Windsurf reads as "blocked", with the reason on stderr. */
const WINDSURF_BLOCK = 2;

/** What the host is told: stdout, or stderr with an exit code for Windsurf. */
export interface ToolReply {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

/**
 * The verdict in the host's words, or null where there is nothing to say. An ask becomes
 * a refusal wherever the host cannot show a person the question.
 */
export function toolReply(
  call: ToolCall,
  ruling: ToolRuling,
  personThere: boolean,
  held: PendingApproval | null = null,
): ToolReply | null {
  if (ruling.effect === DECISION_EFFECT.ALLOW) {
    return call.allowReply === undefined ? null : { stdout: call.allowReply };
  }
  const asking = putsQuestion(call, ruling, personThere);
  const reason = reasonFor(ruling, asking, held);
  if (call.host === EDIT_HOST.WINDSURF)
    return { stderr: reason, exitCode: WINDSURF_BLOCK };
  const decision = asking ? DECISION_EFFECT.ASK : DECISION_EFFECT.DENY;
  if (call.host === EDIT_HOST.GEMINI)
    return { stdout: JSON.stringify({ decision, reason }) };
  if (call.host === EDIT_HOST.CURSOR) {
    const said = { permission: decision, user_message: reason, agent_message: reason };
    return { stdout: JSON.stringify(said) };
  }
  const hookSpecificOutput = {
    hookEventName: EDIT_HOOK_EVENT.PRE_TOOL_USE,
    permissionDecision: decision,
    permissionDecisionReason: reason,
  };
  return { stdout: JSON.stringify({ hookSpecificOutput }) };
}

/** Whether the host shows a person this ruling's question, rather than a refusal in its place. */
export function putsQuestion(
  call: ToolCall,
  ruling: ToolRuling,
  personThere: boolean,
): boolean {
  return ruling.effect === DECISION_EFFECT.ASK && call.nativeAsk && personThere;
}

/** The rule's reason and its way forward, and why a question became a refusal. */
function reasonFor(
  ruling: ToolRuling,
  asking: boolean,
  held: PendingApproval | null,
): string {
  const parts = [`Memnox: ${ruling.reason}`];
  if (ruling.rule !== undefined) parts.push(`(rule ${ruling.rule})`);
  if (ruling.alternative !== undefined)
    parts.push(describeAlternative(ruling.alternative));
  if (ruling.effect === DECISION_EFFECT.ASK && !asking)
    parts.push(held === null ? NO_WAY_TO_ASK : heldText(held));
  return parts.join(' ');
}

/** Whether a ruling is worth a row: a rule had something to say, or something was held. */
export function isWorthRecording(ruling: ToolRuling): boolean {
  return (
    ruling.rule !== undefined ||
    ruling.effect !== DECISION_EFFECT.ALLOW ||
    ruling.shadowEffect !== undefined
  );
}

/** Who a row is filed under, and when. */
export interface ToolRowContext {
  agent: string;
  sessionId: string;
  at: string;
  bundleHash?: string;
  conditionsInForce?: readonly string[];
  /**
   * An ask the host could not put to anybody, so it was refused on the spot.
   * Recorded as blocked, because a row with no ending is an approval the
   * workspace's inbox shows as waiting for ever, on a call nothing is holding.
   */
  refused?: boolean;
}

/** The ledger row for a ruling, keyed the way `why` and `next` read every other seam's. */
export function toolEventFor(
  call: ToolCall,
  ruling: ToolRuling,
  context: ToolRowContext,
): MemnoxEvent {
  return {
    id: newEventId(),
    schemaVersion: EVENT_SCHEMA_VERSION,
    at: context.at,
    sessionId: context.sessionId,
    agent: context.agent,
    actorType: ACTOR_TYPE.AGENT,
    surface: surfaceOf(ruling.action),
    operation: ruling.action,
    class: ruling.class,
    effect: ruling.effect,
    ...(ruling.shadowEffect === undefined ? {} : { shadowEffect: ruling.shadowEffect }),
    mode: ruling.mode,
    reason: `${ruling.reason} (${call.tool}, before it ran)`,
    // A digest of what was named, never the input: a row carries names, not contents.
    argsDigest: digest(ruling.target ?? call.tool),
    ...(ruling.target === undefined ? {} : { target: ruling.target }),
    ...(ruling.rule === undefined ? {} : { rule: localRuleRef(ruling.rule) }),
    ...(ruling.alternative === undefined ? {} : { alternative: ruling.alternative }),
    ...(context.bundleHash === undefined ? {} : { bundleHash: context.bundleHash }),
    ...(context.conditionsInForce === undefined
      ? {}
      : { conditionsInForce: context.conditionsInForce }),
    ...(context.refused === true ? { execution: EXECUTION.BLOCKED } : {}),
  };
}

/** An ask that became a refusal because the host had nobody to put it to. */
export function refusedUnasked(
  call: ToolCall,
  ruling: ToolRuling,
  personThere: boolean,
): boolean {
  return (
    ruling.effect === DECISION_EFFECT.ASK && !putsQuestion(call, ruling, personThere)
  );
}

/** The action's own domain, so a read reads as a file row and a fetch as a network one. */
const SURFACE_BY_PREFIX: Readonly<Record<string, EventSurface>> = {
  filesystem: EVENT_SURFACE.FILESYSTEM,
  http: EVENT_SURFACE.NETWORK,
  mcp: EVENT_SURFACE.MCP,
  git: EVENT_SURFACE.GIT,
};

export function surfaceOf(action: string): EventSurface {
  const [prefix] = action.split('.');
  return SURFACE_BY_PREFIX[prefix ?? ''] ?? EVENT_SURFACE.SHELL;
}
