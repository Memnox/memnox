import {
  BrowserHosts,
  DECISION_EFFECT,
  describeHold,
  digest,
  isAllowed as holdAllowed,
  navigationHost,
  type HoldService,
  type LocalGate,
} from '@memnox/core';

/**
 * A browser driver reaches sites the person is signed into, so the thing worth ruling
 * on is the host — not the script, and not each navigation. One ask per host per
 * session: asking on every page would train somebody to hold the key down, which is
 * worse than not asking at all.
 */

export const BROWSER_ACTION = 'browser.navigate';

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

    const sessionId = this.deps.sessionId ?? 'ses_local';
    if (this.hosts.seen(sessionId, host)) {
      return { allowed: true, host, remembered: true };
    }

    const gate = this.deps.gate;
    const verdict =
      gate === undefined
        ? { effect: DECISION_EFFECT.ALLOW, reason: 'no rules configured' }
        : gate.evaluate({ action: BROWSER_ACTION, target: host });

    if (verdict.effect === DECISION_EFFECT.ALLOW) {
      this.hosts.remember(sessionId, host);
      return { allowed: true, host };
    }

    if (verdict.effect === DECISION_EFFECT.DENY) {
      return { allowed: false, host, message: `Denied by Memnox: ${verdict.reason}` };
    }

    const request = {
      sessionId,
      agent: this.deps.agent ?? 'an agent',
      operation: BROWSER_ACTION,
      target: host,
      fingerprint: digest(`${BROWSER_ACTION}:${host}`),
      reason: verdict.reason,
    };

    const hold = this.deps.hold;
    if (hold === undefined) {
      return {
        allowed: false,
        host,
        message: `${verdict.reason}\nNobody could be asked, so it was denied. Run the agent under "memnox run".`,
      };
    }

    const result = await hold.hold(request);
    if (!holdAllowed(result)) {
      return { allowed: false, host, message: describeHold(result, request) };
    }
    // Answered once, so the rest of this session's pages on this host go straight through.
    this.hosts.remember(sessionId, host);
    return { allowed: true, host };
  }
}
