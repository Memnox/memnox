import { FileGrants } from './session-grants';
import {
  DEFAULT_HOLD_TIMEOUT_MS,
  DEFAULT_UNATTENDED_HOLD_TIMEOUT_MS,
  describeHeldCall,
  HOLD_OUTCOME,
  HoldService,
  isUnanswered,
  type HoldAsked,
  type HoldPrompt,
  type HoldRequest,
  type HoldUnanswered,
} from './hold';
import { PendingApprovals, waitForAnswer } from './pending';
import { TtyHoldPrompt } from './tty-prompt';
import { msToSeconds } from '../domain/time';

/**
 * A held call, written down first and answered from wherever an answer turns up: this
 * terminal, a second one running `memnox approve`, or the control plane reading the file.
 */
export interface RoutedPromptDeps {
  approvals: PendingApprovals;
  /** Asked in parallel when a terminal exists. Absent on a headless machine. */
  tty?: HoldPrompt;
  /** Told where the question is waiting, so nobody has to guess the id. */
  announce?: (message: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}

export class RoutedHoldPrompt implements HoldPrompt {
  constructor(private readonly deps: RoutedPromptDeps) {}

  async ask(
    request: HoldRequest,
    timeoutMs: number,
  ): Promise<HoldAsked | HoldUnanswered | null> {
    const now = this.deps.now ?? Date.now;
    const askedAt = new Date(now()).toISOString();

    const pending = await this.deps.approvals.raise(request, askedAt, timeoutMs);
    this.announce(pending.id, request, timeoutMs);

    // Both routes at once and the first answer wins, so neither approver waits on the other.
    const answers: Promise<HoldAsked | null>[] = [
      waitForAnswer({
        approvals: this.deps.approvals,
        id: pending.id,
        deadline: now() + timeoutMs,
        now,
        ...(this.deps.sleep === undefined ? {} : { sleep: this.deps.sleep }),
        ...(this.deps.pollMs === undefined ? {} : { intervalMs: this.deps.pollMs }),
      }).then((answer) => (answer === null ? null : { answer })),
    ];
    if (this.deps.tty !== undefined) {
      answers.push(this.askTty(this.deps.tty, request, timeoutMs, pending.id));
    }

    const answer = await firstAnswer(answers);
    // Cleared either way, or somebody answers it later for a command long gone.
    await this.deps.approvals.clear(pending.id);
    // Somebody could have answered and nobody did, which is a timeout and not the rule's refusal.
    return answer ?? { unanswered: HOLD_OUTCOME.TIMED_OUT };
  }

  /** Writes the terminal's answer to the file too, so the record says who decided. */
  private async askTty(
    tty: HoldPrompt,
    request: HoldRequest,
    timeoutMs: number,
    id: string,
  ): Promise<HoldAsked | null> {
    const asked = await tty.ask(request, timeoutMs);
    // A terminal that ran out of time gives nothing, since the remote answer may still arrive.
    if (asked === null || isUnanswered(asked)) return null;
    await this.deps.approvals.answer(
      id,
      asked.answer,
      'the terminal',
      new Date((this.deps.now ?? Date.now)()).toISOString(),
    );
    return asked;
  }

  private announce(id: string, request: HoldRequest, timeoutMs: number): void {
    const say = this.deps.announce;
    if (say === undefined) return;
    const what = describeHeldCall(request);
    const seconds = msToSeconds(timeoutMs);
    say(
      `held ${what} for a person (${seconds}s): memnox approve ${id}  |  memnox deny ${id}`,
    );
  }
}

/**
 * The first real answer, giving up only when every route has. `Promise.race` would settle
 * on the first null, so an empty terminal would cancel a remote approval about to arrive.
 */
async function firstAnswer(
  answers: readonly Promise<HoldAsked | null>[],
): Promise<HoldAsked | null> {
  return new Promise((resolve) => {
    let outstanding = answers.length;
    if (outstanding === 0) {
      resolve(null);
      return;
    }
    function settle(value: HoldAsked | null): void {
      if (value !== null) {
        resolve(value);
        return;
      }
      outstanding -= 1;
      if (outstanding === 0) resolve(null);
    }
    for (const answer of answers) {
      void answer.then(settle, () => settle(null));
    }
  });
}

export interface HoldForInput {
  home: string;
  /** Only when a person could actually see it. A headless box has nobody at /dev/tty. */
  interactive: boolean;
  announce?: (message: string) => void;
  timeoutMs?: number;
}

/** Somebody to ask, composed here because the shell wrapper and the MCP proxy both need it. */
export function holdFor(deps: HoldForInput): HoldService {
  return new HoldService(
    new RoutedHoldPrompt({
      approvals: new PendingApprovals(deps.home),
      ...(deps.interactive ? { tty: new TtyHoldPrompt() } : {}),
      ...(deps.announce === undefined ? {} : { announce: deps.announce }),
    }),
    // Somebody elsewhere has to be found and their answer travel back, so they get longer.
    deps.timeoutMs ??
      (deps.interactive ? DEFAULT_HOLD_TIMEOUT_MS : DEFAULT_UNATTENDED_HOLD_TIMEOUT_MS),
    // On disk, because the process that heard the answer is rarely the one asked next.
    new FileGrants(deps.home),
  );
}
