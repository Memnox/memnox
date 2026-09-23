import {
  ACTION,
  BrowserHosts,
  DECISION_EFFECT,
  describeHold,
  digest,
  isAllowed as holdAllowed,
  navigationHost,
  UNNAMED_AGENT,
  UNNAMED_SESSION,
  type HoldService,
  type LocalGate,
} from '@memnox/core';

import { NOBODY_TO_ASK } from './tool-hook.constants';

/**
 * A browser driver reaches sites the person is signed into, so the host is ruled on
 * rather than the script, and asked once per session, since asking per page trains a
 * person to hold the key down.
 */

export const BROWSER_ACTION = ACTION.BROWSER_NAVIGATE;

export interface BrowserGateDeps {
  gate?: LocalGate;
  hold?: HoldService;
  hosts?: BrowserHosts;
  sessionId?: string;
  agent?: string;
}

export interface BrowserOutcome {
  allowed: boolean;
  /** Null for a local target, which is nothing to rule on. */
  host: string | null;
  /** Set when this session had already answered for this host. */
  remembered?: true;
  message?: string;
}

export class BrowserSeam {
  private readonly hosts: BrowserHosts;

  constructor(private readonly deps: BrowserGateDeps = {}) {
    this.hosts = deps.hosts ?? new BrowserHosts();
  }

  async navigate(url: string): Promise<BrowserOutcome> {
    const host = navigationHost(url);
    // Driving your own dev server is not the thing anybody needs to be asked about.
    if (host === null) return { allowed: true, host: null };

    const sessionId = this.deps.sessionId ?? UNNAMED_SESSION;
    if (this.hosts.seen(sessionId, host))
      return { allowed: true, host, remembered: true };

    const gate = this.deps.gate;
    const verdict =
      gate === undefined
        ? { effect: DECISION_EFFECT.ALLOW, reason: 'no rules configured' }
        : gate.evaluate({ action: BROWSER_ACTION, target: host });

    if (verdict.effect === DECISION_EFFECT.DENY) {
      return { allowed: false, host, message: `Denied by Memnox: ${verdict.reason}` };
    }
    if (verdict.effect !== DECISION_EFFECT.ALLOW) {
      const refused = await this.askAbout(sessionId, host, verdict.reason);
      if (refused !== null) return { allowed: false, host, message: refused };
    }
    // Allowed or answered once, so the rest of this
    // session's pages on this host go straight through.
    this.hosts.remember(sessionId, host);
    return { allowed: true, host };
  }

  /** Null when a person allowed it; otherwise what the refusal says. */
  private async askAbout(
    sessionId: string,
    host: string,
    reason: string,
  ): Promise<string | null> {
    const hold = this.deps.hold;
    if (hold === undefined) return `${reason}\n${NOBODY_TO_ASK}`;
    const request = {
      sessionId,
      agent: this.deps.agent ?? UNNAMED_AGENT,
      operation: BROWSER_ACTION,
      target: host,
      fingerprint: digest(`${BROWSER_ACTION}:${host}`),
      reason,
    };
    const result = await hold.hold(request);
    return holdAllowed(result) ? null : describeHold(result, request);
  }
}
