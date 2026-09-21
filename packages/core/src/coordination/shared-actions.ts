import { digest } from '../domain/digest';
import { readAccount, type Account } from '../sync/account';
import {
  runControlPlaneRequest,
  type ControlPlaneReply,
  type Fetcher,
} from '../sync/control-plane-request';
import type { LeaseHolder } from './lease';

/**
 * The workspace's answer to whether somebody else is already doing this exact thing,
 * for the work that writes no path. Unreachable is not taken, and arguments never leave
 * the machine, only their digest with the operation and destination by name.
 */

/** Milliseconds. This sits in front of a tool call, so it must not be felt. */
export const CLAIM_TIMEOUT_MS = 1_500;

/** How long a claim outlives a seam that died holding it. Live work renews instead. */
export const CLAIM_WINDOW_MS = 30_000;

/** How often a seam renews a claim while its work is still running. */
export const CLAIM_RENEW_MS = 10_000;

export const CLAIM_ANSWER = {
  MINE: 'mine',
  /** Somebody else claimed this exact action, and is named. */
  DUPLICATE: 'duplicate',
  /** Somebody else is working on the same thing, doing something else to it. */
  BUSY: 'busy',
  /** Not enrolled, unreachable, too slow, or the workspace does not have it. */
  UNKNOWN: 'unknown',
} as const;

export type ClaimAnswer = (typeof CLAIM_ANSWER)[keyof typeof CLAIM_ANSWER];

export type ClaimOutcome =
  | { answer: typeof CLAIM_ANSWER.MINE }
  | {
      answer: typeof CLAIM_ANSWER.DUPLICATE | typeof CLAIM_ANSWER.BUSY;
      /** Enough to name who: a refusal that will not say gets worked around. */
      agent: string;
      machine?: string;
      at: string;
      operation: string;
      target?: string;
      resource?: string;
    }
  | { answer: typeof CLAIM_ANSWER.UNKNOWN; because: string };

/** What an agent is about to do, before it does it. */
export interface IntendedAction {
  /** What it is, by name: `slack.send_message`, `deploy.service`. */
  operation: string;
  /** Where it lands, by name: a channel, a repository, a service. */
  target?: string;
  /** The arguments, which are hashed here and never sent. */
  arguments: Record<string, string>;
  /** The one thing it acts on, as its provider names it. Absent, the call is compared exactly. */
  resource?: string;
}

/**
 * The digest two agents doing the same thing produce and nobody else does, over the
 * operation, destination and sorted arguments. It never decides two things mean the same.
 */
export function actionFingerprint(action: IntendedAction): string {
  const args = Object.keys(action.arguments)
    .sort()
    .map((key) => `${key}=${action.arguments[key] ?? ''}`)
    .join('\u0000');
  return digest(`${action.operation}\u0000${action.target ?? ''}\u0000${args}`);
}

export interface SharedActions {
  /** Claim it, or renew a claim this holder already has. */
  claim(action: IntendedAction, holder: LeaseHolder): Promise<ClaimOutcome>;
  /** The action returned, so its target is free. Never throws, since a lost finish lapses anyway. */
  finish(action: IntendedAction, holder: LeaseHolder): Promise<void>;
}

/** The control plane's register, over the same account the rest of sync uses. */
export class CloudActions implements SharedActions {
  constructor(
    private readonly home: string,
    private readonly fetcher: Fetcher = globalThis.fetch,
    private readonly timeoutMs: number = CLAIM_TIMEOUT_MS,
  ) {}

  async claim(action: IntendedAction, holder: LeaseHolder): Promise<ClaimOutcome> {
    const account = await readAccount(this.home);
    if (account === null) {
      return { answer: CLAIM_ANSWER.UNKNOWN, because: 'this machine is not enrolled' };
    }
    const reply = await this.send(account, '/coordination/actions', {
      fingerprint: actionFingerprint(action),
      operation: action.operation,
      ...(action.target === undefined ? {} : { target: action.target }),
      ...(action.resource === undefined ? {} : { resource: action.resource }),
      holder: machineHolder(holder, account),
      ttlMs: CLAIM_WINDOW_MS,
    });
    if (reply === null) {
      return {
        answer: CLAIM_ANSWER.UNKNOWN,
        because: 'the control plane did not answer',
      };
    }
    if (!reply.ok) {
      return {
        answer: CLAIM_ANSWER.UNKNOWN,
        because: `the control plane answered ${reply.status}`,
      };
    }
    return parseClaimReply(reply.text);
  }

  /** Failing is silent, since the claim lapses on its own within its window. */
  async finish(action: IntendedAction, holder: LeaseHolder): Promise<void> {
    const account = await readAccount(this.home);
    if (account === null) return;
    await this.send(account, '/coordination/actions/finish', {
      fingerprint: actionFingerprint(action),
      ...(action.resource === undefined ? {} : { resource: action.resource }),
      holder: machineHolder(holder, account),
    });
  }

  private send(
    account: Account,
    route: string,
    body: unknown,
  ): Promise<ControlPlaneReply | null> {
    return runControlPlaneRequest({
      account,
      path: `/v1/workspaces/${account.workspaceId}${route}`,
      body,
      fetcher: this.fetcher,
      timeoutMs: this.timeoutMs,
    });
  }
}

function machineHolder(
  holder: LeaseHolder,
  account: Account,
): { agent: string; session: string; machine: string } {
  return { agent: holder.agent, session: holder.sessionId, machine: account.machineId };
}

/**
 * Keeps a claim alive while its work runs by asking again, and returns the one function
 * that ends it. The timer never keeps the process alive on its own.
 */
export function keepClaimed(
  actions: SharedActions,
  action: IntendedAction,
  holder: LeaseHolder,
  everyMs: number = CLAIM_RENEW_MS,
): () => Promise<void> {
  const timer = setInterval(() => {
    void actions.claim(action, holder).catch(() => undefined);
  }, everyMs);
  timer.unref?.();
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    await actions.finish(action, holder).catch(() => undefined);
  };
}

/** The answer when another agent has it: a repeat, or the same thing. */
export type MeetingOutcome = Extract<
  ClaimOutcome,
  { answer: typeof CLAIM_ANSWER.DUPLICATE | typeof CLAIM_ANSWER.BUSY }
>;

/** How much of an unnamed machine's id reads as an id rather than as noise. */
const SHORT_ID = 8;

/** What to call the other machine: its label, or the first segment of its id, never a whole UUID. */
export function shortMachine(machine: string): string {
  return /^[0-9a-f-]{16,}$/i.test(machine) ? machine.slice(0, SHORT_ID) : machine;
}

/**
 * The sentence an agent is refused with, the same on the proxy and the shell. A repeat
 * calls for doing something else; two agents on one issue is for people to settle.
 */
export function meetingReason(outcome: MeetingOutcome): string {
  const where =
    outcome.machine === undefined ? '' : ` on ${shortMachine(outcome.machine)}`;
  return outcome.answer === CLAIM_ANSWER.DUPLICATE
    ? `${outcome.agent}${where} claimed this exact action at ${outcome.at}, so doing it again would repeat it. ` +
        'Do something else, or ask the person running you whether it should happen twice.'
    : `${outcome.agent}${where} has been working on ${outcome.resource ?? 'this'} since ${outcome.at} (${outcome.operation}). ` +
        'Work on something else, or ask the person running you which of you should own it.';
}

/** The claim answers that name somebody else. */
const MET: readonly string[] = [CLAIM_ANSWER.DUPLICATE, CLAIM_ANSWER.BUSY];

interface ClaimReply {
  outcome?: string;
  by?: {
    agent?: string;
    machine?: string;
    at?: string;
    operation?: string;
    target?: string;
    resource?: string;
  };
}

/** An answer this cannot read is one nobody gave, so the work goes through. */
function parseClaimReply(body: string): ClaimOutcome {
  let parsed: ClaimReply;
  try {
    // Every field is optional and checked below, so a stranger shape reads as mine.
    parsed = JSON.parse(body) as ClaimReply;
  } catch {
    return { answer: CLAIM_ANSWER.MINE };
  }
  const by = parsed?.by;
  if (parsed === null || !MET.includes(parsed.outcome ?? '') || by === undefined) {
    return { answer: CLAIM_ANSWER.MINE };
  }
  return {
    // Checked against MET just above.
    answer: parsed.outcome as MeetingOutcome['answer'],
    agent: by.agent ?? 'another agent',
    at: by.at ?? 'just now',
    operation: by.operation ?? 'the same thing',
    ...(by.machine === undefined ? {} : { machine: by.machine }),
    ...(by.target === undefined ? {} : { target: by.target }),
    ...(by.resource === undefined ? {} : { resource: by.resource }),
  };
}
