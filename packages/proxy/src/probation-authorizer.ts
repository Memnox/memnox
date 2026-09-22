/**
 * A server the daemon wrapped on its own starts on probation: its writes, destructive
 * calls and messages ask a person whatever the rules allow, until the period ends or
 * somebody runs `memnox mcp trust`. Reads pass, since a read is how a server is judged.
 */
import {
  classifyTool,
  containmentAsk,
  DECISION_EFFECT,
  type ContainedProbation,
} from '@memnox/core';

import type { CallAuthorizer, CallVerdict } from './call-authorizer';
import { operationFor } from './ledger';
import type { ToolCall } from './tool-call';

/** Read at every call, so a trust given mid-session applies to the next one. */
export type ProbationLookup = () => Promise<ContainedProbation | null>;

export class ProbationAuthorizer implements CallAuthorizer {
  constructor(
    private readonly inner: CallAuthorizer,
    private readonly serverName: string,
    private readonly probation: ProbationLookup,
  ) {}

  async authorize(call: ToolCall): Promise<CallVerdict> {
    const verdict = await this.inner.authorize(call);
    // Only an allow is turned into an ask; a rule that asks or denies already said more.
    if (verdict.effect !== DECISION_EFFECT.ALLOW) return verdict;
    const probation = await this.probation().catch(() => null);
    if (probation === null) return verdict;
    const asked = containmentAsk(
      { action: operationFor(call.name), target: this.serverName },
      { probation },
      classifyTool({ name: call.name }).class,
    );
    if (asked === null) return verdict;
    return {
      effect: DECISION_EFFECT.ASK,
      reason: asked.reason,
      signals: [...(verdict.signals ?? []), asked.signal],
    };
  }

  async settle(call: ToolCall): Promise<void> {
    await this.inner.settle?.(call);
  }

  async close(): Promise<void> {
    await this.inner.close?.();
  }
}
