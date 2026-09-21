import { createInterface, type Interface } from 'node:readline';
import { openTerminal, type TerminalStreams } from '../gate/terminal';
import { describeLease, type Lease } from './lease';
import {
  LEASE_ANSWER,
  type LeaseAnswer,
  type LeaseAsked,
  type LeasePrompt,
} from './lease-gate';
import { msToSeconds } from '../domain/time';

/**
 * The question a second writer is asked: who holds the path, for how long, and what
 * they have been doing, read from the register, since that says whether it is the same work.
 */

/** Enough of what a holder has been doing to end an argument, and never a log. */
const ACTIVITY_SHOWN = 3;

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
  const seconds = Math.max(1, msToSeconds(waitMs));
  const lines = [
    '',
    `  MEMNOX  ${wanted === '' ? 'this repository' : wanted} is held`,
    `          ${describeLease(held, moment)}`,
  ];
  if (held.activity.length > 0) {
    lines.push('');
    for (const note of held.activity.slice(-ACTIVITY_SHOWN))
      lines.push(`          ${note}`);
  }
  lines.push('');
  // The wait is named in seconds so nobody has to wonder whether this can hang.
  lines.push(`  [w] wait up to ${seconds}s   [t] take it anyway   [d] don't`);
  lines.push('  > ');
  return lines.join('\n');
}

export const REASON_PROMPT = '  why are you taking it? (empty cancels):\n  > ';

/** One question in flight: what is held, what was wanted, and how long to wait. */
interface HeldQuestion {
  held: Lease;
  wanted: string;
  moment: string;
  waitMs: number;
}

export class TtyLeasePrompt implements LeasePrompt {
  constructor(private readonly open: () => TerminalStreams = openTerminal) {}

  async ask(
    held: Lease,
    wanted: string,
    moment: string,
    waitMs: number,
  ): Promise<LeaseAsked | null> {
    let streams: TerminalStreams;
    try {
      streams = this.open();
    } catch {
      // No controlling terminal. The caller waits it out rather than hanging on a question.
      return null;
    }

    const rl = createInterface({ input: streams.input, output: streams.output });
    try {
      return await race(rl, { held, wanted, moment, waitMs });
    } finally {
      rl.close();
    }
  }
}

function race(rl: Interface, question: HeldQuestion): Promise<LeaseAsked | null> {
  const { held, wanted, moment, waitMs } = question;
  return new Promise((resolve) => {
    // A walk-away becomes a bounded wait rather than a takeover.
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
