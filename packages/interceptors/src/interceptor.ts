import { basename, delimiter, dirname, join } from 'node:path';
import {
  classifyBinary,
  COMMAND_CLASS,
  DECISION_EFFECT,
  describeHold,
  digest,
  isAllowed as holdAllowed,
  MEMNOX_HOME,
  type BinaryVerdict,
  type HoldService,
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
}

export interface InterceptDeps {
  gate?: LocalGate;
  hold?: HoldService;
  sessionId?: string;
  agent?: string;
  log: (message: string) => void;
}

/** The name the interceptor was invoked as, which is how one binary serves every interceptor. */
export function invokedAs(argv0: string): string {
  return basename(argv0);
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
  const classified = classifyBinary(binary, args);
  const verdict: BinaryVerdict = classified ?? {
    action: 'shell.execute',
    class: COMMAND_CLASS.NORMAL,
    because: binary,
  };
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

  if (decision.effect === DECISION_EFFECT.ASK) {
    const held = await askPerson(verdict, decision.reason, deps);
    if (held === null) return base;
    return { ...base, allowed: false, message: held };
  }

  return { ...base, allowed: false, message: refusal(verdict, decision) };
}

async function askPerson(
  verdict: BinaryVerdict,
  reason: string,
  deps: InterceptDeps,
): Promise<string | null> {
  const hold = deps.hold;
  const request = {
    sessionId: deps.sessionId ?? 'ses_local',
    agent: deps.agent ?? 'an agent',
    operation: verdict.action,
    fingerprint: digest(`${verdict.action}:${verdict.target ?? ''}`),
    reason,
    ...(verdict.target === undefined ? {} : { target: verdict.target }),
  };

  if (hold === undefined) {
    return `${reason}\nNobody could be asked, so it was denied. Run the agent under "memnox run".`;
  }
  const result = await hold.hold(request);
  return holdAllowed(result) ? null : describeHold(result, request);
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
  return `Denied by Memnox: ${decision.reason}\n(${verdict.because})${instead}`;
}

/** Where the real binary lives, found along PATH with our own directory removed. */
export function resolveReal(
  binary: string,
  path: string,
  exists: (p: string) => boolean,
): string | null {
  for (const entry of path.split(delimiter)) {
    if (entry === '') continue;
    const candidate = join(entry, binary);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** The parent of a resolved binary, for a message that tells somebody where to look. */
export function directoryOf(resolved: string): string {
  return dirname(resolved);
}
