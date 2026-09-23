import {
  containmentAsk,
  DECISION_EFFECT,
  describeEgress,
  digest,
  hostOfDestination,
  inspectEgress,
  isAllowed as holdAllowed,
  UNNAMED_AGENT,
  UNNAMED_SESSION,
  type ActionRequest,
  type Containment,
  type DecisionEffect,
  type HoldService,
} from '@memnox/core';

import {
  describeVerdict,
  type HookAuthorizer,
  type HookVerdict,
} from './hook-authorizer';
import { EGRESS_CONNECT_ACTION, EGRESS_REQUEST_ACTION } from './tool-hook.constants';

/**
 * Whether one outbound request may go, by destination and by what it carries. Nothing is
 * ever rewritten on the way through: this reports and the caller decides.
 */

/**
 * Declared, so a screen can print them: a governed agent
 * with an unwatched side channel is worse than none.
 */
export const EGRESS_BLIND_SPOTS: readonly string[] = [
  'the payload inside an HTTPS tunnel, where the destination is gated and the body is not',
  'any connection that does not go through this proxy',
  'a protocol that is not HTTP or CONNECT',
  'which agent sent a request, beyond the session its proxy URL declares',
];

export interface EgressOutcome {
  allowed: boolean;
  /** Returned to the client on a refusal, and logged either way. */
  message?: string;
}

export interface HttpAttempt {
  method: string;
  /** Absolute-form, as a forward proxy receives it. */
  url: string;
  headers?: Readonly<Record<string, string>>;
  /** Read only for plain HTTP; a tunnelled body never reaches this seam. */
  body?: string;
}

/**
 * Who is asking, as the client declared it in the proxy URL `memnox run` handed it.
 * Declared rather than proven, so it attributes a request and never loosens one.
 */
export interface EgressCaller {
  sessionId?: string;
  agent?: string;
}

/** One ruling, as the ledger and the destination record take it. */
export interface EgressRuling {
  caller: EgressCaller;
  action: string;
  target: string;
  effect: DecisionEffect;
  reason: string;
}

export interface EgressSeamDeps {
  authorizer: HookAuthorizer;
  /**
   * Somebody to ask. Absent means an ask does not
   * go and says so, which is right for a test only.
   */
  hold?: HoldService;
  sessionId?: string;
  /** The session's containment: untrusted, or an agent on probation. */
  contain?: (caller: EgressCaller) => Promise<Containment | null>;
  /** Told every ruling, for the ledger and the per-agent destination record. */
  ruled?: (ruling: EgressRuling) => Promise<void>;
}

/** Headers worth ruling on. The rest are transport noise and are not carried. */
const CARRIED_HEADERS: readonly string[] = [
  'authorization',
  'cookie',
  'x-api-key',
  'proxy-authorization',
];

export class EgressSeam {
  constructor(private readonly deps: EgressSeamDeps) {}

  async gateRequest(
    attempt: HttpAttempt,
    caller: EgressCaller = {},
  ): Promise<EgressOutcome> {
    const fields = fieldsOf(attempt);
    const request = {
      action: EGRESS_REQUEST_ACTION,
      target: attempt.url,
      arguments: fields,
      ...this.session(caller),
    };

    // Cheap and certain, and before anything is asked: this never leaves the machine.
    const inspection = inspectEgress({ destination: attempt.url, fields });
    if (inspection.findings.length > 0) {
      const refused = { allowed: false, message: describeEgress(inspection) };
      return this.told(request, caller, refused);
    }
    return this.told(request, caller, await this.rule(request, caller));
  }

  /**
   * All that is knowable about a tunnel is where it goes, so that is all it is ruled on.
   */
  async gateConnect(
    authority: string,
    caller: EgressCaller = {},
  ): Promise<EgressOutcome> {
    const request = {
      action: EGRESS_CONNECT_ACTION,
      target: authority,
      ...this.session(caller),
    };
    return this.told(request, caller, await this.rule(request, caller));
  }

  private session(caller: EgressCaller): { sessionId?: string } {
    const sessionId = caller.sessionId ?? this.deps.sessionId;
    return sessionId === undefined ? {} : { sessionId };
  }

  private async rule(
    request: ActionRequest,
    caller: EgressCaller,
  ): Promise<EgressOutcome> {
    const verdict = await this.contained(
      request,
      caller,
      await this.deps.authorizer.authorize(request),
    );
    if (verdict.effect === DECISION_EFFECT.ALLOW) return { allowed: true };
    if (verdict.effect === DECISION_EFFECT.ASK) {
      const asked = await this.ask(request, verdict, caller);
      return asked ?? { allowed: true };
    }
    return { allowed: false, message: describeVerdict(verdict) };
  }

  /** The rules' allow, turned into an ask where the session or its agent is contained. */
  private async contained(
    request: ActionRequest,
    caller: EgressCaller,
    verdict: HookVerdict,
  ): Promise<HookVerdict> {
    const contain = this.deps.contain;
    if (verdict.effect !== DECISION_EFFECT.ALLOW || contain === undefined) return verdict;
    const containment = await contain(caller);
    const asked = containment === null ? null : containmentAsk(request, containment);
    return asked === null
      ? verdict
      : { effect: DECISION_EFFECT.ASK, reason: asked.reason };
  }

  /** Every ruling reaches the ledger and the destination record. Never fails the request. */
  private async told(
    request: ActionRequest,
    caller: EgressCaller,
    outcome: EgressOutcome,
  ): Promise<EgressOutcome> {
    const ruled = this.deps.ruled;
    if (ruled === undefined) return outcome;
    await ruled({
      caller,
      action: request.action,
      target: request.target ?? '',
      effect: outcome.allowed ? DECISION_EFFECT.ALLOW : DECISION_EFFECT.DENY,
      reason: outcome.message ?? 'allowed',
    }).catch(() => undefined);
    return outcome;
  }

  /** Puts an ask to a person. Null when it was allowed and the request may go. */
  private async ask(
    request: ActionRequest,
    verdict: HookVerdict,
    caller: EgressCaller,
  ): Promise<EgressOutcome | null> {
    const hold = this.deps.hold;
    if (hold === undefined) {
      return {
        allowed: false,
        message: `${describeVerdict(verdict)} Nobody could be asked, so it did not go.`,
      };
    }

    const result = await hold.hold({
      sessionId: request.sessionId ?? UNNAMED_SESSION,
      agent: caller.agent ?? UNNAMED_AGENT,
      operation: request.action,
      fingerprint: digest(`${request.action}:${request.target ?? ''}`),
      reason: verdict.reason,
      ...(request.target === undefined ? {} : { target: request.target }),
    });
    if (!holdAllowed(result)) {
      return { allowed: false, message: describeVerdict(verdict) };
    }
    this.deps.authorizer.personAllowed(request);
    return null;
  }
}

/** Flattened to strings, which is what a policy and the inspector both match on. */
function fieldsOf(attempt: HttpAttempt): Record<string, string> {
  const fields: Record<string, string> = { method: attempt.method, url: attempt.url };
  for (const name of CARRIED_HEADERS) {
    const value = attempt.headers?.[name];
    if (value !== undefined && value.length > 0) fields[name] = value;
  }
  if (attempt.body !== undefined && attempt.body.length > 0)
    fields['body'] = attempt.body;
  return fields;
}

/** Where a request went, without its path or query, which is where a secret would ride. */
export function destinationOf(target: string): string {
  return hostOfDestination(target) ?? target;
}
