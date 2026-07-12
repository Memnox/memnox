import { DECISION_EFFECT } from '@memnox/core';
import type { MemnoxClient } from '@memnox/sdk';
import { MCP_ACTION_PREFIX } from './firewall.constants';

export interface CallVerdict {
  readonly allowed: boolean;
  readonly reason: string;
}

/** Decides whether one tool call may reach the wrapped server. */
export interface CallAuthorizer {
  authorize(toolName: string): Promise<CallVerdict>;
}

/** No runtime configured — the static tool filters are the only gate. */
export class UngovernedAuthorizer implements CallAuthorizer {
  async authorize(): Promise<CallVerdict> {
    return { allowed: true, reason: 'no runtime configured' };
  }
}

export interface RuntimeAuthorizerOptions {
  serverName: string;
  sessionId?: string;
  /** Forward calls when the runtime is unreachable. Default false — a firewall fails closed. */
  failOpen?: boolean;
  log: (message: string) => void;
}

export class RuntimeAuthorizer implements CallAuthorizer {
  constructor(
    private readonly client: MemnoxClient,
    private readonly options: RuntimeAuthorizerOptions,
  ) {}

  async authorize(toolName: string): Promise<CallVerdict> {
    try {
      const decision = await this.client.check({
        action: `${MCP_ACTION_PREFIX}.${toolName}`,
        target: this.options.serverName,
        sessionId: this.options.sessionId,
      });
      if (decision.effect === DECISION_EFFECT.ALLOW) {
        return { allowed: true, reason: decision.reason };
      }
      const approvalHint = decision.approvalId
        ? ` Approval pending: memnox approvals resolve ${decision.approvalId} --by <you>.`
        : '';
      return { allowed: false, reason: `${decision.reason}.${approvalHint}` };
    } catch (err) {
      if (this.options.failOpen) {
        this.options.log(`runtime unreachable, failing open: ${String(err)}`);
        return { allowed: true, reason: 'runtime unreachable (fail-open)' };
      }
      return {
        allowed: false,
        reason:
          'Memnox runtime unreachable — failing closed. Start it or set MEMNOX_MCP_FAIL_OPEN=true.',
      };
    }
  }
}
