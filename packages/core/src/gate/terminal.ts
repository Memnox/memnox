import { createReadStream, createWriteStream } from 'node:fs';

/**
 * The controlling terminal, asked directly rather than through stdin, because stdin
 * belongs to the protocol the agent is speaking and a question written there corrupts it.
 */

const TTY = '/dev/tty';

export interface TerminalStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

/** Throws where there is no controlling terminal, which every caller reads as nobody to ask. */
export function openTerminal(): TerminalStreams {
  return { input: createReadStream(TTY), output: createWriteStream(TTY) };
}
