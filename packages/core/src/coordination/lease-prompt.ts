import { createInterface } from 'node:readline';
import { createReadStream, createWriteStream } from 'node:fs';
import { describeLease, type Lease } from './lease';
import {
  LEASE_ANSWER,
  type LeaseAnswer,
  type LeaseAsked,
  type LeasePrompt,
} from './lease-gate';

/**
 * The question a second writer is asked. Everything on it is read from the register
 * rather than guessed: who holds the path, how long they have held it, and what they
 * have actually been doing with it.
 *
 * That last line is the one that earns this screen. "cursor has src/billing" is a fact
 * somebody argues with; "cursor wrote invoice.ts and ran the billing tests" is the
 * sentence that tells this agent whether it is about to do the same work twice.
 */
const TTY = '/dev/tty';

const KEYS: Readonly<Record<string, LeaseAnswer>> = {
  w: LEASE_ANSWER.WAIT,
  t: LEASE_ANSWER.TAKE,
  d: LEASE_ANSWER.REFUSE,
  n: LEASE_ANSWER.REFUSE,
};

export function heldQuestionFor(
  held: Lease,
  wanted: string,
  moment: string,
  waitMs: number,
): string {
  const seconds = Math.max(1, Math.round(waitMs / 1000));
  const lines = [
    '',
    `  MEMNOX  ${wanted === '' ? 'this repository' : wanted} is held`,
    `          ${describeLease(held, moment)}`,
  ];
  if (held.activity.length > 0) {
    lines.push('');
    for (const note of held.activity.slice(-3)) lines.push(`          ${note}`);
  }
  lines.push('');
  // The wait is named in seconds so nobody has to wonder whether this can hang.
  lines.push(`  [w] wait up to ${seconds}s   [t] take it anyway   [d] don't`);
  lines.push('  > ');
  return lines.join('\n');
}

export const REASON_PROMPT = '  why are you taking it? (empty cancels):\n  > ';

export class TtyLeasePrompt implements LeasePrompt {
  constructor(
    private readonly open: () => {
      input: NodeJS.ReadableStream;
      output: NodeJS.WritableStream;
    } = () => ({ input: createReadStream(TTY), output: createWriteStream(TTY) }),
  ) {}

  async ask(
    held: Lease,
    wanted: string,
    moment: string,
    waitMs: number,
  ): Promise<LeaseAsked | null> {
    let streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream };
    try {
      streams = this.open();
    } catch {
      // No controlling terminal. The caller waits it out rather than hanging on a question.
      return null;
    }

    const rl = createInterface({ input: streams.input, output: streams.output });
    try {
      return await this.race(rl, held, wanted, moment, waitMs);
    } finally {
      rl.close();
    }
  }

  private race(
    rl: ReturnType<typeof createInterface>,
    held: Lease,
    wanted: string,
    moment: string,
    waitMs: number,
  ): Promise<LeaseAsked | null> {
    return new Promise((resolve) => {
      /* A walk-away becomes a wait, not a takeover: the wait is bounded anyway, and
         nobody's afternoon should be lost because somebody left the room. */
      const timer = setTimeout(() => resolve({ answer: LEASE_ANSWER.WAIT }), waitMs);
      timer.unref?.();

      rl.question(heldQuestionFor(held, wanted, moment, waitMs), (raw) => {
        const answer = KEYS[raw.trim().toLowerCase().charAt(0)] ?? LEASE_ANSWER.WAIT;
        if (answer !== LEASE_ANSWER.TAKE) {
          clearTimeout(timer);
          resolve({ answer });
          return;
        }
        // Taking it is a row, so the reason is asked for before it becomes one.
        rl.question(REASON_PROMPT, (reason) => {
          clearTimeout(timer);
          resolve({ answer: LEASE_ANSWER.TAKE, reason: reason.trim() });
        });
      });
    });
  }
}
