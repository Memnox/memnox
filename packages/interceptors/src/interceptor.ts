import { basename, delimiter, join } from 'node:path';
import {
  DECISION_EFFECT,
  describeHold,
  digest,
  evidenceFor,
  HOLD_OUTCOME,
  isAllowed as holdAllowed,
  MEMNOX_HOME,
  refusalShapeFor,
  renderEvidence,
  type BinaryVerdict,
  type HoldService,
  type Overlay,
  resolveAction,
  type LocalGate,
} from '@memnox/core';

/** The directory that goes on the front of PATH. Every entry in it is this one binary. */
export const INTERCEPTOR_DIR = 'bin';

export function interceptorDirFor(home: string): string {
  return join(home, MEMNOX_HOME, INTERCEPTOR_DIR);
}

/**
 * PATH with our directory removed, so the interceptor can find the binary it stands in front
 * of. Without this the interceptor would exec itself, which is a fork bomb rather than a gate.
 */
export function realPath(path: string, home: string): string {
  const ours = interceptorDirFor(home);
  return path
    .split(delimiter)
    .filter((entry) => entry !== '' && entry !== ours)
    .join(delimiter);
}

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
  rule?: { name: string; layer: string; file: string };
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
  log: (message: string) => void;
}

/** Our own name. Nothing resolved to this may ever be exec'd — that is the fork bomb. */
export const INTERCEPT_BINARY = 'memnox-intercept';

/**
 * The wrapper passes the binary it stands for as the first argument, so one executable
 * serves every entry in the directory. Reading it from argv[1] instead would read our
 * own path, classify us, and exec us again — which is a fork bomb, not a gate.
 */
export function invokedFor(
  argv: readonly string[],
): { binary: string; args: string[] } | null {
  const binary = argv[2];
  if (binary === undefined || basename(binary) === INTERCEPT_BINARY) return null;
  return { binary: basename(binary), args: [...argv.slice(3)] };
}

/**
 * Evaluate, then exec. Nothing here reads the file the command names or the output it
 * produces: the interceptor sees argv and a verdict, and the real binary does the work.
 */
export async function ruleOnCommand(
  binary: string,
  args: readonly string[],
  deps: InterceptDeps,
): Promise<InterceptOutcome> {
  /* The verb table first, so what `memnox scan` promised about this CLI is exactly
     what happens here. The generic classifier is the fallback for binaries nobody has
     written a table for. */
  const verdict = verdictFor(binary, args, deps.env ?? {});
  const argsDigest = digest(args.join(' '));

  const base: InterceptOutcome = {
    allowed: true,
    binary,
    args: [...args],
    action: verdict.action,
    class: verdict.class,
    argsDigest,
    ...(verdict.target === undefined ? {} : { target: verdict.target }),
  };

  const gate = deps.gate;
  if (gate === undefined) return base;

  const decision = gate.evaluate({
    action: verdict.action,
    ...(verdict.target === undefined ? {} : { target: verdict.target }),
  });

  if (decision.effect === DECISION_EFFECT.ALLOW) return base;

  /* The same lines under an ask and under a deny: what somebody is shown when they can
     do something about it must be what they are shown when they cannot. */
  const shown = renderEvidence(
    evidenceFor({
      matched: decision.matchedPolicies,
      moment: new Date().toISOString(),
      ...(deps.overlays === undefined ? {} : { overlays: deps.overlays }),
    }),
  );

  /* The rule, carried alongside the message a person reads. A row that stored only the
     rendered refusal would make `why` quote a paragraph where it should name a rule. */
  const matched = decision.matchedPolicies[0];
  const decided = {
    reason: decision.reason,
    ...(matched === undefined
      ? {}
      : { rule: { name: matched.name, layer: 'project', file: 'policy' } }),
  };

  if (decision.effect === DECISION_EFFECT.ASK) {
    const held = await askPerson(
      verdict,
      decision.reason,
      shown,
      [binary, ...args],
      deps,
    );
    if (held === null) return { ...base, ...decided };
    if (typeof held !== 'string') {
      return {
        ...base,
        ...decided,
        allowed: false,
        edited: held.edited,
        message: held.message,
      };
    }
    return { ...base, ...decided, allowed: false, message: held };
  }

  return {
    ...base,
    ...decided,
    allowed: false,
    message: [refusal(verdict, decision), ...shown].join('\n'),
  };
}

async function askPerson(
  verdict: BinaryVerdict,
  reason: string,
  evidence: readonly string[],
  command: readonly string[],
  deps: InterceptDeps,
): Promise<string | { message: string; edited: string } | null> {
  const hold = deps.hold;
  const request = {
    sessionId: deps.sessionId ?? 'ses_local',
    agent: deps.agent ?? 'an agent',
    operation: verdict.action,
    fingerprint: digest(`${verdict.action}:${verdict.target ?? ''}`),
    reason,
    evidence,
    command: command.join(' '),
    ...(verdict.target === undefined ? {} : { target: verdict.target }),
  };

  if (hold === undefined) {
    return `${reason}\nNobody could be asked, so it was denied. Run the agent under "memnox run".`;
  }
  const result = await hold.hold(request);
  if (holdAllowed(result)) return null;
  /* An edit is handed back rather than run: what replaces the command goes through the
     rules from the start, or "[e]" is the way around every one of them. */
  if (result.outcome === HOLD_OUTCOME.EDITED && result.edited !== undefined) {
    return { message: describeHold(result, request), edited: result.edited };
  }
  return describeHold(result, request);
}

function refusal(
  verdict: BinaryVerdict,
  decision: {
    reason: string;
    alternative?: { action: string; resource?: string; note: string };
  },
): string {
  const alternative = decision.alternative;
  // A refusal that names no way forward is a dead end the agent abandons the task over.
  const instead =
    alternative === undefined
      ? ''
      : `\nInstead: ${alternative.action}${
          alternative.resource === undefined ? '' : ` ${alternative.resource}`
        } — ${alternative.note}`;
  /* The same sentence the MCP proxy gives, because an agent that meets both seams
     must not learn two different things about whether a refusal is worth retrying. */
  const { guidance } = refusalShapeFor(DECISION_EFFECT.DENY, decision.reason);
  return `Denied by Memnox: ${decision.reason}\n(${verdict.because})${instead}\n${guidance}`;
}

/** Where the real binary lives, found along PATH with our own directory removed. */
export function resolveReal(
  binary: string,
  path: string,
  exists: (p: string) => boolean,
): string | null {
  /* Never our own executable: a second line under `realPath`, because one stray PATH
     entry there would otherwise mean a process that spawns itself without end. */
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
    class: resolved.class as BinaryVerdict['class'],
    because: resolved.because,
    ...(resolved.target === undefined ? {} : { target: resolved.target }),
  };
}
