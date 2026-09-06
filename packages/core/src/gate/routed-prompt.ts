import {
  DEFAULT_HOLD_TIMEOUT_MS,
  HOLD_ANSWER,
  HoldService,
  type HoldAsked,
  type HoldPrompt,
  type HoldRequest,
} from './hold';
import { PendingApprovals, waitForAnswer } from './pending';
import { TtyHoldPrompt } from './tty-prompt';

/**
 * A held call, asked of whoever is actually there.
 *
 * Every seam had an optional hold and none of them ever built one, so an `ask` rule
 * reached `Nobody could be asked, so it was denied` — on a laptop with somebody
 * sitting at it, and on a VPS at three in the morning alike. That made `ask` a
 * synonym for `deny`, which is the single thing that stops an agent being left to run.
 *
 * So the question is written down first and answered from wherever an answer turns
 * up: the terminal, if there is one; a second terminal running `memnox approve`; or
 * the control plane, which reads the same file. The waiting side does not know or
 * care which, and that is what makes an unattended run possible at all.
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

  async ask(request: HoldRequest, timeoutMs: number): Promise<HoldAsked | null> {
    const now = this.deps.now ?? Date.now;
    const askedAt = new Date(now()).toISOString();

    const pending = await this.deps.approvals.raise(request, askedAt, timeoutMs);
    this.announce(pending.id, request, timeoutMs);

    const deadline = now() + timeoutMs;
    /* Both at once, and the first answer wins. A person at the keyboard should not
       have to wait out a remote approver, and a remote approver should not be locked
       out because somebody happens to be logged in. */
    const answers: Promise<HoldAsked | null>[] = [
      waitForAnswer(
        this.deps.approvals,
        pending.id,
        deadline,
        now,
        this.deps.sleep,
        this.deps.pollMs,
      ).then((answer) => (answer === null ? null : { answer })),
    ];
    if (this.deps.tty !== undefined) {
      answers.push(this.askTty(this.deps.tty, request, timeoutMs, pending.id));
    }

    const answer = await first(answers);
    /* Cleared either way. A record that outlived its question is one somebody answers
       later, for a command that stopped running an hour ago. */
    await this.deps.approvals.clear(pending.id);
    return answer;
  }

  /** Writes the terminal's answer to the file too, so the record says who decided. */
  private async askTty(
    tty: HoldPrompt,
    request: HoldRequest,
    timeoutMs: number,
    id: string,
  ): Promise<HoldAsked | null> {
    const asked = await tty.ask(request, timeoutMs);
    if (asked === null) return null;
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
    const what =
      request.target === undefined
        ? request.operation
        : `${request.operation} ${request.target}`;
    const seconds = Math.round(timeoutMs / 1000);
    say(
      `held ${what} for a person (${seconds}s): memnox approve ${id}  |  memnox deny ${id}`,
    );
  }
}

/**
 * The first answer, ignoring the ones that never come.
 *
 * `Promise.race` would settle on the first *rejection* or the first null, so a
 * terminal that nobody is sitting at would cancel a remote approval that was about to
 * arrive. This waits for a real answer, and only gives up when every route has.
 */
async function first(
  answers: readonly Promise<HoldAsked | null>[],
): Promise<HoldAsked | null> {
  return new Promise((resolve) => {
    let outstanding = answers.length;
    if (outstanding === 0) {
      resolve(null);
      return;
    }
    let settled = false;
    for (const answer of answers) {
      void answer
        .then((value) => {
          if (settled) return;
          if (value !== null) {
            settled = true;
            resolve(value);
            return;
          }
          outstanding -= 1;
          if (outstanding === 0) {
            settled = true;
            resolve(null);
          }
        })
        .catch(() => {
          if (settled) return;
          outstanding -= 1;
          if (outstanding === 0) {
            settled = true;
            resolve(null);
          }
        });
    }
  });
}

export { HOLD_ANSWER };

/**
 * Somebody to ask, composed for a seam.
 *
 * Lives here rather than beside one seam because two of them need it and neither is
 * allowed to depend on the other: the shell wrapper and the MCP proxy are both
 * transports, and a transport importing another transport is how a layering rule
 * stops meaning anything.
 */
export function holdFor(deps: {
  home: string;
  /** Only when a person could actually see it. A headless box has nobody at /dev/tty. */
  interactive: boolean;
  announce?: (message: string) => void;
  timeoutMs?: number;
}): HoldService {
  return new HoldService(
    new RoutedHoldPrompt({
      approvals: new PendingApprovals(deps.home),
      ...(deps.interactive ? { tty: new TtyHoldPrompt() } : {}),
      ...(deps.announce === undefined ? {} : { announce: deps.announce }),
    }),
    deps.timeoutMs ?? DEFAULT_HOLD_TIMEOUT_MS,
  );
}
