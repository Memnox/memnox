import { basename, delimiter, join } from 'node:path';

import {
  DECISION_EFFECT,
  alternativeFor,
  describeAlternative,
  describeHold,
  digest,
  evidenceFor,
  HOLD_OUTCOME,
  isAllowed as holdAllowed,
  localRuleRef,
  refusalShapeFor,
  renderEvidence,
  resolveAction,
  UNNAMED_AGENT,
  UNNAMED_SESSION,
  type BinaryVerdict,
  type EventRuleRef,
  type HoldService,
  type LocalGate,
  type LocalVerdict,
  type Overlay,
  SCOPE_MATCH,
} from '@memnox/core';

import { NOBODY_TO_ASK } from './tool-hook.constants';

/**
 * One command line ruled on before its binary runs: the verb
 * table's verdict, the local rules, and a person where a rule
 * asks for one. Nothing here reads a file or runs a thing.
 */

/**
 * node, this script, the binary being wrapped: the command's own arguments start here.
 */
const WRAPPER_ARGV_START = 3;

// Defined in core, because core's own git calls need them and cannot import from here.
export { INTERCEPTOR_DIR, interceptorDirFor, realPath } from '@memnox/core';

export interface InterceptOutcome {
  allowed: boolean;
  /** What the interceptor should exec, once it is allowed to. */
  binary: string;
  args: string[];
  action: string;
  class: string;
  target?: string;
  /** Printed to stderr when the answer is no. Always names a way forward. */
  message?: string;
  /** Recorded against the decision. A digest, never the arguments. */
  argsDigest: string;
  /** What a person typed instead. The caller rules on it again; it is never trusted. */
  edited?: string;
  /** The rule's own reason, apart from the message a person reads. For the ledger. */
  reason?: string;
  /** The rule that decided, so `why` can name it rather than only quote it. */
  rule?: EventRuleRef;
  /** Outside what the session declared it was for, which is what the breaker counts. */
  outOfScope?: boolean;
}

export interface InterceptDeps {
  gate?: LocalGate;
  /** Read for a database host only; nothing else here looks at the environment. */
  env?: NodeJS.ProcessEnv;
  hold?: HoldService;
  /** What is in force, so the refusal can name the freeze rather than only the rule. */
  overlays?: readonly Overlay[];
  sessionId?: string;
  agent?: string;
  now?: () => Date;
}

/** Our own name. Nothing resolved to this may ever be exec'd, which is the fork bomb. */
export const INTERCEPT_BINARY = 'memnox-intercept';

/**
 * The binary the wrapper stands for is argv[2]; argv[1]
 * is our own path, and ruling on that is a fork bomb.
 */
export function invokedFor(
  argv: readonly string[],
): { binary: string; args: string[] } | null {
  const binary = argv[2];
  if (binary === undefined || basename(binary) === INTERCEPT_BINARY) return null;
  return { binary: basename(binary), args: [...argv.slice(WRAPPER_ARGV_START)] };
}

/**
 * Evaluate, then exec: the interceptor sees argv
 * and a verdict, and the real binary does the work.
 */
export async function ruleOnCommand(
  binary: string,
  args: readonly string[],
  deps: InterceptDeps,
): Promise<InterceptOutcome> {
  // The verb table first, so what `memnox scan`
  // promised about this CLI is what happens here.
  const verdict = verdictFor(binary, args, deps.env ?? {});
  const base = baseOutcome(binary, args, verdict);
  const gate = deps.gate;
  if (gate === undefined) return base;

  const request = {
    action: verdict.action,
    toolClass: verdict.class,
    ...(verdict.target === undefined ? {} : { target: verdict.target }),
  };
  const decision = gate.evaluate(request);
  const scoped = outsideScope(decision) ? { ...base, outOfScope: true } : base;
  if (decision.effect === DECISION_EFFECT.ALLOW) return observed(scoped, decision);

  const decided = { ...scoped, ...decidedBy(decision) };
  const evidence = evidenceLines(decision, deps);
  if (decision.effect === DECISION_EFFECT.ASK) {
    const command = [binary, ...args];
    const held = await askPerson({
      verdict,
      reason: decision.reason,
      evidence,
      command,
      deps,
    });
    // A yes is learned, so the same new thing is not asked about twice.
    if (held === null) gate.personAllowed(request);
    return held === null ? decided : { ...decided, ...held, allowed: false };
  }
  const message = [refusal(verdict, decision), ...evidence].join('\n');
  return { ...decided, allowed: false, message };
}

/** Only a declared task has a scope to be outside of; with none, nothing is counted. */
function outsideScope(decision: LocalVerdict): boolean {
  return decision.scope?.match === SCOPE_MATCH.OUT_OF_SCOPE;
}

/** An allow that enforce would have asked about keeps the reason, so the row says so. */
function observed(base: InterceptOutcome, decision: LocalVerdict): InterceptOutcome {
  return decision.shadowEffect === undefined
    ? base
    : { ...base, reason: decision.reason };
}

function baseOutcome(
  binary: string,
  args: readonly string[],
  verdict: BinaryVerdict,
): InterceptOutcome {
  return {
    allowed: true,
    binary,
    args: [...args],
    action: verdict.action,
    class: verdict.class,
    argsDigest: digest(args.join(' ')),
    ...(verdict.target === undefined ? {} : { target: verdict.target }),
  };
}

/**
 * The rule, carried beside the message, so `why`
 * names a rule rather than quoting a paragraph.
 */
function decidedBy(decision: LocalVerdict): Pick<InterceptOutcome, 'reason' | 'rule'> {
  const matched = decision.matchedPolicies[0];
  return {
    reason: decision.reason,
    ...(matched === undefined ? {} : { rule: localRuleRef(matched.name) }),
  };
}

/**
 * The same lines under an ask and a deny: what somebody
 * can act on is what they see when they cannot.
 */
function evidenceLines(decision: LocalVerdict, deps: InterceptDeps): string[] {
  return renderEvidence(
    evidenceFor({
      matched: decision.matchedPolicies,
      moment: (deps.now ?? ((): Date => new Date()))().toISOString(),
      ...(deps.overlays === undefined ? {} : { overlays: deps.overlays }),
    }),
  );
}

interface AskInput {
  verdict: BinaryVerdict;
  reason: string;
  evidence: readonly string[];
  command: readonly string[];
  deps: InterceptDeps;
}

/**
 * Null when a person allowed it; otherwise what they
 * are told, and any command they typed instead.
 */
async function askPerson(
  input: AskInput,
): Promise<{ message: string; edited?: string } | null> {
  const { verdict, deps } = input;
  const request = {
    sessionId: deps.sessionId ?? UNNAMED_SESSION,
    agent: deps.agent ?? UNNAMED_AGENT,
    operation: verdict.action,
    fingerprint: digest(`${verdict.action}:${verdict.target ?? ''}`),
    reason: input.reason,
    evidence: input.evidence,
    command: input.command.join(' '),
    ...(verdict.target === undefined ? {} : { target: verdict.target }),
  };

  const hold = deps.hold;
  if (hold === undefined) return { message: `${input.reason}\n${NOBODY_TO_ASK}` };
  const result = await hold.hold(request);
  if (holdAllowed(result)) return null;
  const message = describeHold(result, request);
  // An edit is handed back rather than run, or "[e]" is the way around every rule.
  if (result.outcome === HOLD_OUTCOME.EDITED && result.edited !== undefined) {
    return { message, edited: result.edited };
  }
  return { message };
}

function refusal(verdict: BinaryVerdict, decision: LocalVerdict): string {
  // A refusal that names no way forward is a dead end the agent abandons the task over,
  // so a generated rule's "ask somebody" gives way to the verb table's own, as in the shell.
  const alternative = alternativeFor(
    decision.alternative,
    verdict.alternative,
    verdict.action,
  );
  const instead =
    alternative === undefined ? '' : `\n${describeAlternative(alternative)}`;
  // The MCP proxy's sentence, so an agent meeting
  // both seams learns one thing about retrying.
  const { guidance } = refusalShapeFor(DECISION_EFFECT.DENY, decision.reason);
  return `Denied by Memnox: ${decision.reason}\n(${verdict.because})${instead}\n${guidance}`;
}

/** Where the real binary lives, found along PATH with our own directory removed. */
export function resolveReal(
  binary: string,
  path: string,
  exists: (candidate: string) => boolean,
): string | null {
  // A second line under `realPath`: one stray PATH
  // entry would otherwise spawn itself without end.
  if (basename(binary) === INTERCEPT_BINARY) return null;
  for (const entry of path.split(delimiter)) {
    if (entry === '') continue;
    const candidate = join(entry, binary);
    if (basename(candidate) === INTERCEPT_BINARY) continue;
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** The one resolver in core, so every surface agrees on what a command line is. */
export function verdictFor(
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): BinaryVerdict {
  const resolved = resolveAction(binary, args, env);
  return {
    action: resolved.action,
    // A verb table may name a class beyond the command
    // classes, and every reader takes any class string.
    class: resolved.class as BinaryVerdict['class'],
    because: resolved.because,
    ...(resolved.target === undefined ? {} : { target: resolved.target }),
    ...(resolved.alternative === undefined ? {} : { alternative: resolved.alternative }),
  };
}
