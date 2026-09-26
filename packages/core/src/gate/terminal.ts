import { openSync } from 'node:fs';
import { ReadStream, WriteStream } from 'node:tty';

/**
 * The controlling terminal, asked directly rather than through stdin, because stdin
 * belongs to the protocol the agent is speaking and a question written there corrupts it.
 */

const TTY = '/dev/tty';

export interface TerminalStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** Present on a real terminal, so a question can be answered with one key. */
  setRawMode?: (raw: boolean) => void;
  /** How wide the terminal is, where it says. */
  columns?: number;
  /** Lets the terminal go, so a process that asked can still exit. */
  close?: () => void;
}

/**
 * Opened as a terminal rather than as a file, since only a terminal stream can read one
 * key at a time and knows its own width. Throws where there is no controlling terminal,
 * which every caller reads as nobody to ask.
 */
export function openTerminal(): TerminalStreams {
  const input = new ReadStream(openSync(TTY, 'r'));
  const output = new WriteStream(openSync(TTY, 'w'));
  return {
    input,
    output,
    setRawMode: (raw) => input.setRawMode(raw),
    columns: output.columns,
    close: () => {
      input.destroy();
      output.destroy();
    },
  };
}
