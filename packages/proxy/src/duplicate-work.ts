import {
  actionFingerprint,
  actionResource,
  CLAIM_ANSWER,
  DECISION_EFFECT,
  changesExternalState,
  classifyTool,
  keepClaimed,
  meetingReason,
  TOOL_CLASS,
  type IntendedAction,
  type LeaseHolder,
  type SharedActions,
  type ToolClass,
} from '@memnox/core';
import { isCallAllowed, type CallAuthorizer, type CallVerdict } from './call-authorizer';
import type { ToolCall } from './tool-call';

/**
 * The other agent, on the other machine, about to send the same message: once work leaves
 * the machine there is no path to hold, so the workspace is asked first.
 */

/** A read is never claimed; anything that names one thing and is not a read is. */
function isWorthClaiming(toolClass: ToolClass, resource: string | undefined): boolean {
  if (changesExternalState(toolClass)) return true;
  return toolClass === TOOL_CLASS.UNKNOWN && resource !== undefined;
}

/**
 * Only what leaves the machine is claimed, an unknown answer
 * lets the call go, and a duplicate is refused with the holder's
 * name. It wraps the rules, holding with no policy file.
 */
export class DuplicateWorkAuthorizer implements CallAuthorizer {
  /**
   * Claims held while their calls run, by fingerprint,
   * counted since one call may be out twice.
   */
  private readonly running = new Map<
    string,
    { release: () => Promise<void>; calls: number }
  >();

  /** Finishes already on their way, which an exiting proxy must wait for. */
  private readonly finishing = new Set<Promise<void>>();

  constructor(
    private readonly inner: CallAuthorizer,
    private readonly actions: SharedActions,
    private readonly holder: LeaseHolder,
    private readonly serverName: string,
  ) {}

  /** The inner verdict, or a refusal naming who already has this call's work. */
  async authorize(call: ToolCall): Promise<CallVerdict> {
    const verdict = await this.inner.authorize(call);
    // Asked only of an allowed call, or a refused agent would hold a thing it never does.
    if (!isCallAllowed(verdict)) return verdict;
    const action = this.actionOf(call);
    if (action === null) return verdict;

    const outcome = await this.actions.claim(action, this.holder);
    if (outcome.answer === CLAIM_ANSWER.MINE) {
      this.hold(action);
      return verdict;
    }
    if (outcome.answer === CLAIM_ANSWER.UNKNOWN) return verdict;

    const reason = meetingReason(outcome);
    return { effect: DECISION_EFFECT.DENY, reason };
  }

  personAllowed(call: ToolCall): void {
    this.inner.personAllowed?.(call);
  }

  /** The call returned, so its claim is let go now rather than when it lapses. */
  async settle(call: ToolCall): Promise<void> {
    const action = this.actionOf(call);
    if (action === null) return;
    const key = actionFingerprint(action);
    const held = this.running.get(key);
    if (held === undefined) return;
    held.calls -= 1;
    if (held.calls > 0) return;
    this.running.delete(key);
    await this.track(held.release());
  }

  /**
   * Let go of everything still held, or a claim
   * outlives the proxy with nobody working on it.
   */
  async close(): Promise<void> {
    const held = [...this.running.values()];
    this.running.clear();
    for (const each of held) void this.track(each.release());
    // Including those a returned call started, or
    // exiting now leaves their claims standing.
    await Promise.all([...this.finishing]);
  }

  private async track(finish: Promise<void>): Promise<void> {
    this.finishing.add(finish);
    try {
      await finish;
    } finally {
      this.finishing.delete(finish);
    }
  }

  /** What this call claims, or null where it is not one two agents collide over. */
  private actionOf(call: ToolCall): IntendedAction | null {
    const resource = actionResource(this.serverName, call.arguments);
    if (!isWorthClaiming(classifyTool({ name: call.name }).class, resource)) return null;
    return {
      operation: `${this.serverName}.${call.name}`,
      arguments: call.arguments,
      ...(resource === undefined ? {} : { resource }),
    };
  }

  /** Renewed while the call runs, so a long one stays held however long it takes. */
  private hold(action: IntendedAction): void {
    const key = actionFingerprint(action);
    const held = this.running.get(key);
    if (held !== undefined) {
      held.calls += 1;
      return;
    }
    this.running.set(key, {
      release: keepClaimed(this.actions, action, this.holder),
      calls: 1,
    });
  }
}
