import { createInterface } from 'node:readline';

import { HOLD_ANSWER, type HoldAsked, type HoldPrompt, type HoldRequest } from './hold';
import { answerForKey, choicesFor, renderCard } from './permission-card';
import { openTerminal, type TerminalStreams } from './terminal';

/**
 * A held call asked on the controlling terminal, never on the agent's own stdin. On a
 * real terminal it is a card answered with the arrows or one key; anywhere else, the
 * same card answered with a number and enter.
 */

const DEFAULT_COLUMNS = 80;
const TICK_MS = 1000;

const KEY = {
  UP: '\u001b[A',
  DOWN: '\u001b[B',
  ENTER_CR: '\r',
  ENTER_LF: '\n',
  ESCAPE: '\u001b',
  CTRL_C: '\u0003',
} as const;

const CURSOR = {
  HIDE: '\u001b[?25l',
  SHOW: '\u001b[?25h',
  CLEAR_DOWN: '\u001b[J',
  up: (lines: number): string => (lines > 0 ? `\u001b[${lines}A\r` : '\r'),
} as const;

/** The card as a line prompt reads it, for a stream that cannot take one key at a time. */
export function questionFor(request: HoldRequest, remainingMs = 0): string {
  const card = renderCard(request, {
    selected: 0,
    remainingMs,
    width: DEFAULT_COLUMNS,
    color: false,
    interactive: false,
  });
  return `\n${card.join('\n')}\n  > `;
}

/** Shown with the command already in the line, so a wrong flag is one keystroke away. */
export function editPromptFor(request: HoldRequest): string {
  return `  edit, then enter (empty cancels):\n  ${request.command ?? ''}\n  > `;
}

/** On a real terminal the command is already on the line, ready to change. */
const EDIT_IN_PLACE = '  Edit the command, then enter (empty cancels):\n  > ';

export interface TtyPromptDeps {
  /** Opening the terminal is the one thing here that touches the machine. */
  open?: () => TerminalStreams;
  now?: () => number;
}

export class TtyHoldPrompt implements HoldPrompt {
  constructor(private readonly deps: TtyPromptDeps = {}) {}

  async ask(request: HoldRequest, timeoutMs: number): Promise<HoldAsked | null> {
    const open = this.deps.open ?? openTerminal;
    let streams: TerminalStreams;
    try {
      streams = open();
    } catch {
      // No controlling terminal: a cron job, a container, a detached process.
      return null;
    }
    try {
      if (streams.setRawMode !== undefined) {
        const picked = await this.pick(streams, request, timeoutMs);
        if (picked !== HOLD_ANSWER.EDIT)
          return picked === null ? null : { answer: picked };
      }
      return await this.byLine(streams, request, timeoutMs);
    } finally {
      streams.close?.();
    }
  }

  /** The card with a moving arrow, redrawn in place until a choice or the clock ends it. */
  private pick(
    streams: TerminalStreams,
    request: HoldRequest,
    timeoutMs: number,
  ): Promise<HoldAsked['answer'] | null> {
    const now = this.deps.now ?? Date.now;
    const deadline = now() + timeoutMs;
    const choices = choicesFor(request);
    const card = new DrawnCard(streams, request);
    let selected = 0;
    return new Promise((resolve) => {
      const finish = (answer: HoldAsked['answer'] | null): void => {
        clearInterval(ticking);
        streams.input.removeListener('data', onKey);
        card.close(answer);
        resolve(answer);
      };
      const onKey = (chunk: Buffer | string): void => {
        const key = chunk.toString();
        if (key === KEY.UP || key === KEY.DOWN) {
          const step = key === KEY.UP ? -1 : 1;
          selected = (selected + step + choices.length) % choices.length;
          card.draw(selected, deadline - now());
          return;
        }
        if (key === KEY.ENTER_CR || key === KEY.ENTER_LF) {
          finish(choices[selected]?.answer ?? HOLD_ANSWER.DENY);
          return;
        }
        // Escape and ctrl-c both mean no, never a yes by accident.
        if (key === KEY.ESCAPE || key === KEY.CTRL_C) {
          finish(HOLD_ANSWER.DENY);
          return;
        }
        const answer = answerForKey(request, key);
        if (answer !== null) finish(answer);
      };
      // Denied on timeout, never allowed: a walk-away must not become a yes.
      const ticking = setInterval(() => {
        const left = deadline - now();
        if (left <= 0) finish(null);
        else card.draw(selected, left);
      }, TICK_MS);
      ticking.unref?.();
      card.open(deadline - now());
      streams.input.on('data', onKey);
    });
  }

  /** A number or a letter and enter, for a stream with no raw mode, and for editing. */
  private byLine(
    streams: TerminalStreams,
    request: HoldRequest,
    timeoutMs: number,
  ): Promise<HoldAsked | null> {
    // A real terminal gets line editing, so the command it is handed can be changed in place.
    const editing = streams.setRawMode !== undefined;
    const rl = createInterface({
      input: streams.input,
      output: streams.output,
      terminal: editing,
    });
    return new Promise<HoldAsked | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      timer.unref?.();
      const edit = (): void => {
        // The same clock keeps running: editing must not become a way to wait for ever.
        const asked = editing ? EDIT_IN_PLACE : editPromptFor(request);
        rl.question(asked, (edited) => {
          clearTimeout(timer);
          resolve({ answer: HOLD_ANSWER.EDIT, command: edited.trim() });
        });
        if (editing && request.command !== undefined) rl.write(request.command);
      };
      if (editing) {
        edit();
        return;
      }
      rl.question(questionFor(request, timeoutMs), (raw) => {
        const answer = answerForKey(request, raw.trim().charAt(0)) ?? HOLD_ANSWER.DENY;
        if (answer !== HOLD_ANSWER.EDIT || request.command === undefined) {
          clearTimeout(timer);
          resolve({ answer });
          return;
        }
        edit();
      });
    }).finally(() => rl.close());
  }
}

/** The card on screen: drawn once, redrawn over itself, and left as one line saying what was chosen. */
class DrawnCard {
  private height = 0;

  constructor(
    private readonly streams: TerminalStreams,
    private readonly request: HoldRequest,
  ) {}

  open(remainingMs: number): void {
    this.streams.setRawMode?.(true);
    this.write(CURSOR.HIDE);
    this.draw(0, remainingMs);
  }

  draw(selected: number, remainingMs: number): void {
    const lines = renderCard(this.request, {
      selected,
      remainingMs,
      width: this.streams.columns ?? DEFAULT_COLUMNS,
      color: true,
      interactive: true,
    });
    this.write(`${CURSOR.up(this.height)}${CURSOR.CLEAR_DOWN}${lines.join('\n')}\n`);
    this.height = lines.length;
  }

  /** Raw mode off and the cursor back whatever happened, or the person's shell is left broken. */
  close(answer: HoldAsked['answer'] | null): void {
    this.write(`${CURSOR.up(this.height)}${CURSOR.CLEAR_DOWN}${CURSOR.SHOW}`);
    this.write(`${outcomeLine(this.request, answer)}\n`);
    this.streams.setRawMode?.(false);
  }

  private write(text: string): void {
    this.streams.output.write(text);
  }
}

const OUTCOME: Readonly<Record<string, string>> = {
  [HOLD_ANSWER.ONCE]: 'allowed once',
  [HOLD_ANSWER.SESSION]: 'allowed for this session',
  [HOLD_ANSWER.DENY]: 'refused',
  [HOLD_ANSWER.EDIT]: 'editing',
};

/** What stays on screen once the card is gone, so the scrollback says what was decided. */
function outcomeLine(request: HoldRequest, answer: HoldAsked['answer'] | null): string {
  const what = request.command ?? `${request.operation} ${request.target ?? ''}`.trim();
  const said = answer === null ? 'nobody answered, so refused' : OUTCOME[answer];
  return `  Memnox · ${what} · ${said ?? answer}`;
}
