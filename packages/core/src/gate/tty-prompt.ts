import { createInterface } from 'node:readline';
import { createReadStream, createWriteStream } from 'node:fs';
import { HOLD_ANSWER, type HoldAnswer, type HoldPrompt, type HoldRequest } from './hold';

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
};

export function questionFor(request: HoldRequest): string {
  const what =
    request.target === undefined
      ? request.operation
      : `${request.operation} ${request.target}`;
  return [
    '',
    `  MEMNOX  ${request.agent} wants to ${what}`,
    `          ${request.reason}`,
    '',
    '  [a] allow once   [s] allow for this session   [d] deny',
    '  > ',
  ].join('\n');
}

export interface TtyPromptDeps {
  /** Opening the terminal is the one thing here that touches the machine. */
  open?: () => { input: NodeJS.ReadableStream; output: NodeJS.WritableStream };
}

export class TtyHoldPrompt implements HoldPrompt {
  constructor(private readonly deps: TtyPromptDeps = {}) {}

  async ask(request: HoldRequest, timeoutMs: number): Promise<HoldAnswer | null> {
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
  ): Promise<HoldAnswer | null> {
    return new Promise((resolve) => {
      // Denied on timeout, never allowed: a walk-away must not become a yes.
      const timer = setTimeout(() => resolve(null), timeoutMs);
      timer.unref?.();

      rl.question(questionFor(request), (raw) => {
        clearTimeout(timer);
        const key = raw.trim().toLowerCase().charAt(0);
        resolve(KEYS[key] ?? HOLD_ANSWER.DENY);
      });
    });
  }
}
