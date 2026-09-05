import { createInterface } from 'node:readline';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  HOLD_ANSWER,
  type HoldAnswer,
  type HoldAsked,
  type HoldPrompt,
  type HoldRequest,
} from './hold';

/**
 * Asks on the controlling terminal rather than on stdin, because stdin belongs to the
 * MCP protocol the agent is speaking. Writing a question into that stream would
 * corrupt the conversation the question is about.
 */
const TTY = '/dev/tty';

const KEYS: Readonly<Record<string, HoldAnswer>> = {
  a: HOLD_ANSWER.ONCE,
  y: HOLD_ANSWER.ONCE,
  s: HOLD_ANSWER.SESSION,
  d: HOLD_ANSWER.DENY,
  n: HOLD_ANSWER.DENY,
  e: HOLD_ANSWER.EDIT,
};

export function questionFor(request: HoldRequest): string {
  const what =
    request.target === undefined
      ? request.operation
      : `${request.operation} ${request.target}`;

  const lines = [
    '',
    `  MEMNOX  ${request.agent} wants to ${what}`,
    `          ${request.reason}`,
  ];
  /* The evidence is why this is arguable rather than annoying: a person who can see the
     freeze and the rule argues with whoever set them, not with the tool. */
  if (request.evidence !== undefined && request.evidence.length > 0) {
    lines.push('');
    lines.push(...request.evidence);
  }
  lines.push('');
  lines.push(
    request.command === undefined
      ? '  [a] allow once   [s] allow for this session   [d] deny'
      : '  [a] allow once   [s] allow for this session   [e] edit it   [d] deny',
  );
  lines.push('  > ');
  return lines.join('\n');
}

/** Shown with the command already in the line, so a wrong flag is one keystroke away. */
export function editPromptFor(request: HoldRequest): string {
  return `  edit, then enter (empty cancels):\n  ${request.command ?? ''}\n  > `;
}

export interface TtyPromptDeps {
  /** Opening the terminal is the one thing here that touches the machine. */
  open?: () => { input: NodeJS.ReadableStream; output: NodeJS.WritableStream };
}

export class TtyHoldPrompt implements HoldPrompt {
  constructor(private readonly deps: TtyPromptDeps = {}) {}

  async ask(request: HoldRequest, timeoutMs: number): Promise<HoldAsked | null> {
    const open =
      this.deps.open ??
      (() => ({ input: createReadStream(TTY), output: createWriteStream(TTY) }));

    let streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream };
    try {
      streams = open();
    } catch {
      // No controlling terminal: a cron job, a container, a detached process.
      return null;
    }

    const rl = createInterface({ input: streams.input, output: streams.output });
    try {
      return await this.race(rl, request, timeoutMs);
    } finally {
      rl.close();
    }
  }

  private race(
    rl: ReturnType<typeof createInterface>,
    request: HoldRequest,
    timeoutMs: number,
  ): Promise<HoldAsked | null> {
    return new Promise((resolve) => {
      // Denied on timeout, never allowed: a walk-away must not become a yes.
      const timer = setTimeout(() => resolve(null), timeoutMs);
      timer.unref?.();

      rl.question(questionFor(request), (raw) => {
        const answer = KEYS[raw.trim().toLowerCase().charAt(0)] ?? HOLD_ANSWER.DENY;
        if (answer !== HOLD_ANSWER.EDIT || request.command === undefined) {
          clearTimeout(timer);
          resolve({ answer });
          return;
        }
        // The same clock keeps running: editing must not become a way to wait for ever.
        rl.question(editPromptFor(request), (edited) => {
          clearTimeout(timer);
          resolve({ answer: HOLD_ANSWER.EDIT, command: edited.trim() });
        });
      });
    });
  }
}
