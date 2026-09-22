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
import { isAllowed, type CallAuthorizer, type CallVerdict } from './call-authorizer';
import type { ToolCall } from './tool-call';

/** A read is never claimed; anything that names one thing and is not a read is. */
function worthClaiming(toolClass: ToolClass, resource: string | undefined): boolean {
  if (changesExternalState(toolClass)) return true;
  return toolClass === TOOL_CLASS.UNKNOWN && resource !== undefined;
}

/**
 * The other agent, on the other machine, about to send the same message.
 *
 * A lease covers two agents writing one file, and the moment work leaves this
 * machine there is no path to hold: two agents each deciding to post the same
 * Slack message, open the same issue or restart the same service collide in the
 * same way and nothing local can see it. The workspace can, so this asks it before
 * a call that changes anything outside goes through.
 *
 * Four rules keep it from becoming the thing people turn off:
 *
 * **Only what leaves the machine.** A read is never claimed, so nothing here can
 * make a lookup wait, and two agents reading one channel is normal.
 *
 * **Unknown is not taken.** Not enrolled, unreachable, too slow, or a plan without
 * it: the call goes through. This is coordination rather than safety, and the
 * rules are what refuse an action.
 *
 * **A duplicate is refused with a name, never a bare no.** The agent is told who
 * has it and when, which is what lets it do something else rather than retry.
 *
 * **Wrapped around the rules rather than folded into them**, like the pause and
 * the budget beside it: this is not a statement about what an agent is allowed to
 * do, and it has to hold on a machine with no policy file at all.
 */
export class DuplicateWorkAuthorizer implements CallAuthorizer {
  /**
   * Claims held while their calls run, by fingerprint. Counted, because one
   * session may have the same call out twice, and the claim is let go only when
   * the last of them returns.
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
    /** What the server said each tool is, where it said anything. */
    private readonly classOf: (call: ToolCall) => ToolClass = (call) =>
      classifyTool({ name: call.name }).class,
  ) {}

  /**
   * Whether this call is one two agents could collide over.
   *
   * A write or a message always is. A call this cannot classify counts too, but
   * only where the provider named the one thing it acts on: `close_pull_request`
   * is not in anybody's verb table and is plainly work on that pull request. A
   * **read** never counts, whatever it names, so nothing here can make a lookup
   * wait, which is the same rule `takesLease` holds the file register to.
   */
  async authorize(call: ToolCall): Promise<CallVerdict> {
    const verdict = await this.inner.authorize(call);
    /* Asked only of a call the rules already allow: an action that is about to be
       refused needs no claim, and claiming it would have the refused agent hold a
       thing it never does. */
    if (!isAllowed(verdict)) return verdict;
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
   * Let go of everything still held, because the proxy is exiting.
   *
   * An agent that ends its session right after a call takes the proxy down
   * with it, and a claim the proxy never finished would leave the thing busy
   * for the rest of its window with nobody working on it.
   */
  async close(): Promise<void> {
    const held = [...this.running.values()];
    this.running.clear();
    for (const each of held) void this.track(each.release());
    /* Including the ones a returned call already started: the process ending
       now would cut them off halfway and leave their claims standing. */
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
    if (!worthClaiming(this.classOf(call), resource)) return null;
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
