import type { ActionRequest } from '@memnox/core';
import { DECISION_EFFECT, describeEgress, inspectEgress } from '@memnox/core';
import type { HookAuthorizer, HookVerdict } from './hook-authorizer';

export const EGRESS_REQUEST_ACTION = 'http.request';
/** A tunnel is a different question from a request: only the destination is knowable. */
export const EGRESS_CONNECT_ACTION = 'http.connect';

/**
 * Declared, and the first one is the whole reason this seam is honest about itself.
 * A governed agent with an unwatched side channel is worse than an ungoverned one.
 */
export const EGRESS_BLIND_SPOTS: readonly string[] = [
  'the payload inside an HTTPS tunnel — the destination is gated, the body is not',
  'any connection that does not go through this proxy',
  'a protocol that is not HTTP or CONNECT',
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

export interface EgressSeamDeps {
  authorizer: HookAuthorizer;
  sessionId?: string;
}

/** Headers worth ruling on. The rest are transport noise and are not carried. */
const CARRIED_HEADERS: readonly string[] = [
  'authorization',
  'cookie',
  'x-api-key',
  'proxy-authorization',
];

/**
 * Destination and payload, both, where both are visible. An allowed host carrying a
 * credential is still a refusal, and nothing is ever rewritten on the way through —
 * modifying a payload and letting it pass is a bug the agent cannot see.
 */
export class EgressSeam {
  constructor(private readonly deps: EgressSeamDeps) {}

  async gateRequest(attempt: HttpAttempt): Promise<EgressOutcome> {
    const fields = fieldsOf(attempt);

    // Cheap and certain, and before anything is asked: this never leaves the machine.
    const inspection = inspectEgress({ destination: attempt.url, fields });
    if (inspection.findings.length > 0) {
      return { allowed: false, message: describeEgress(inspection) };
    }

    return this.rule({
      action: EGRESS_REQUEST_ACTION,
      target: attempt.url,
      arguments: fields,
      ...(this.deps.sessionId === undefined ? {} : { sessionId: this.deps.sessionId }),
    });
  }

  /**
   * All that is knowable about a tunnel is where it goes. Ruling on the destination and
   * saying plainly that the body is unseen beats pretending to inspect it.
   */
  async gateConnect(authority: string): Promise<EgressOutcome> {
    return this.rule({
      action: EGRESS_CONNECT_ACTION,
      target: authority,
      ...(this.deps.sessionId === undefined ? {} : { sessionId: this.deps.sessionId }),
    });
  }

  private async rule(request: ActionRequest): Promise<EgressOutcome> {
    const verdict = await this.deps.authorizer.authorize(request);
    if (verdict.effect === DECISION_EFFECT.ALLOW) return { allowed: true };
    return { allowed: false, message: describe(verdict) };
  }
}

/** Flattened to strings, which is what a policy and the inspector both match on. */
function fieldsOf(attempt: HttpAttempt): Record<string, string> {
  const fields: Record<string, string> = { method: attempt.method, url: attempt.url };
  for (const name of CARRIED_HEADERS) {
    const value = attempt.headers === undefined ? undefined : attempt.headers[name];
    if (value !== undefined && value.length > 0) fields[name] = value;
  }
  if (attempt.body !== undefined && attempt.body.length > 0)
    fields['body'] = attempt.body;
  return fields;
}

/** The alternative rides all the way to whoever made the call. */
function describe(verdict: HookVerdict): string {
  const parts = [verdict.reason];
  if (verdict.alternative !== undefined) {
    const target =
      verdict.alternative.resource === undefined
        ? ''
        : ` ${verdict.alternative.resource}`;
    parts.push(
      `Instead: ${verdict.alternative.action}${target} — ${verdict.alternative.note}`,
    );
  }
  if (verdict.approvalId !== undefined) {
    parts.push(`Ask a person: memnox approvals resolve ${verdict.approvalId} --by <you>`);
  }
  if (verdict.decisionId !== undefined) {
    parts.push(`Why: memnox why ${verdict.decisionId}`);
  }
  return parts.join(' ');
}
