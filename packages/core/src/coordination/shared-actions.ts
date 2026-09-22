import { digest } from '../domain/digest';
import { readAccount } from '../sync/account';
import type { LeaseHolder } from './lease';

/**
 * The workspace's answer to "is somebody else already doing this exact thing".
 *
 * A lease answers it for a path, and most of what an agent does writes no path at
 * all: it posts the message, opens the issue, restarts the service. Two agents on
 * two machines each deciding to send the same Slack message collide in exactly the
 * way two agents in one file do, and only the control plane can see it, which is
 * why this half of coordination is the part a team pays for.
 *
 * The three rules the shared lease is built on hold here too. **Unreachable is not
 * taken**: every failure reads as "nobody could tell me" and the caller proceeds,
 * because a seam that refused an agent's work whenever the network hiccuped is one
 * people turn off. **No account, no call.** And **bounded**: one short request on a
 * path an agent is waiting on.
 *
 * **The arguments never leave the machine.** What travels is a digest of them,
 * with the operation and destination by name, which is the same bargain the ledger
 * makes: names, never payloads.
 */

/** Milliseconds. This sits in front of a tool call, so it must not be felt. */
export const CLAIM_TIMEOUT_MS = 1_500;

/**
 * How long a claim stands unless it is renewed.
 *
 * A claim means "doing this now", so it is short, and a seam renews it for as
 * long as the work runs. This is only how long it outlives a seam that died
 * holding it.
 */
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
  /**
   * The one thing it acts on, as its provider would name it. Absent where no
   * provider names it, which leaves the call compared exactly and nothing
   * else, the way every call was before this.
   */
  resource?: string;
}

/**
 * The digest two agents doing the same thing produce and nobody else does.
 *
 * Over the operation, the destination and every argument, with the keys sorted so
 * two callers that built the same call in a different order still match. Two
 * *different* messages hash differently and are two pieces of work, which is the
 * whole claim this makes: it never decides that two things mean the same thing.
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
  /**
   * The action returned. The thing it was on is free at once, and the exact
   * action counts as a repeat for a few seconds more. Never throws: a finish
   * that does not arrive leaves a claim that lapses on its own.
   */
  finish(action: IntendedAction, holder: LeaseHolder): Promise<void>;
}

type Fetcher = typeof globalThis.fetch;

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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetcher(
        `${account.baseUrl}/v1/workspaces/${account.workspaceId}/coordination/actions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${account.token}`,
          },
          body: JSON.stringify({
            fingerprint: actionFingerprint(action),
            operation: action.operation,
            ...(action.target === undefined ? {} : { target: action.target }),
            ...(action.resource === undefined ? {} : { resource: action.resource }),
            holder: {
              agent: holder.agent,
              session: holder.sessionId,
              machine: account.machineId,
            },
            ttlMs: CLAIM_WINDOW_MS,
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        return {
          answer: CLAIM_ANSWER.UNKNOWN,
          because: `the control plane answered ${response.status}`,
        };
      }
      return read(await response.text());
    } catch {
      // Unreachable, aborted, or not JSON. All of them mean nobody could tell us.
      return {
        answer: CLAIM_ANSWER.UNKNOWN,
        because: 'the control plane did not answer',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  finish(action: IntendedAction, holder: LeaseHolder): Promise<void> {
    return finishClaim(this.home, this.fetcher, this.timeoutMs, action, holder);
  }
}

/**
 * Finishes a claim this machine made.
 *
 * The same bounds as a claim: no account, no call, and one short request.
 * Failing is silent, because the claim it would have finished lapses in
 * seconds anyway.
 */
async function finishClaim(
  home: string,
  fetcher: Fetcher,
  timeoutMs: number,
  action: IntendedAction,
  holder: LeaseHolder,
): Promise<void> {
  const account = await readAccount(home);
  if (account === null) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    await fetcher(
      `${account.baseUrl}/v1/workspaces/${account.workspaceId}/coordination/actions/finish`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${account.token}`,
        },
        body: JSON.stringify({
          fingerprint: actionFingerprint(action),
          ...(action.resource === undefined ? {} : { resource: action.resource }),
          holder: {
            agent: holder.agent,
            session: holder.sessionId,
            machine: account.machineId,
          },
        }),
        signal: controller.signal,
      },
    );
  } catch {
    // Unreachable or too slow: the claim lapses on its own within its window.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Keeps a claim alive while its work runs, and returns what ends it.
 *
 * A claim is short on purpose, so a seam that holds one for longer than its
 * window renews it by claiming again, which the workspace reads as this same
 * holder asking. The returned function stops renewing and finishes the claim,
 * and it is the only thing a seam has to call once the work returns. The timer
 * never keeps a process alive on its own.
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

/**
 * What to call the other machine.
 *
 * The workspace answers with what a person called it, and with its id where
 * nobody has. A whole UUID in a sentence an agent reads out is noise, and the
 * first segment still tells two machines apart.
 */
export function shortMachine(machine: string): string {
  return /^[0-9a-f-]{16,}$/i.test(machine) ? machine.slice(0, SHORT_ID) : machine;
}

/**
 * The sentence an agent is refused with, from whichever seam refused it.
 *
 * Two different refusals, because they call for different things. A repeat is
 * work already being done and the answer is to do something else; two agents
 * on one issue is a question about who should own it, which only the people
 * running them can settle. One sentence for the proxy and the shell both, so an
 * agent refused on either surface reads the same thing.
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

/** An answer this cannot read is one nobody gave, so the work goes through. */
function read(body: string): ClaimOutcome {
  try {
    const parsed = JSON.parse(body) as {
      outcome?: string;
      by?: {
        agent?: string;
        machine?: string;
        at?: string;
        operation?: string;
        target?: string;
        resource?: string;
      };
    };
    const met =
      parsed.outcome === 'duplicate'
        ? CLAIM_ANSWER.DUPLICATE
        : parsed.outcome === 'busy'
          ? CLAIM_ANSWER.BUSY
          : null;
    if (met === null || parsed.by === undefined) {
      return { answer: CLAIM_ANSWER.MINE };
    }
    const by = parsed.by;
    return {
      answer: met,
      agent: by.agent ?? 'another agent',
      at: by.at ?? 'just now',
      operation: by.operation ?? 'the same thing',
      ...(by.machine === undefined ? {} : { machine: by.machine }),
      ...(by.target === undefined ? {} : { target: by.target }),
      ...(by.resource === undefined ? {} : { resource: by.resource }),
    };
  } catch {
    return { answer: CLAIM_ANSWER.MINE };
  }
}
