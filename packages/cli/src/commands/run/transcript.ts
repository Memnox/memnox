/**
 * What the agent printed, on its way to the transcript with its credentials masked. The
 * terminal still sees the stream untouched; only the copy that stays on disk is rewritten.
 */
import { Transform, type Readable, type Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import { redactSecrets } from '@memnox/core';

const NEWLINE = '\n';

/**
 * Past this, what is held is not a line any rule was written for, and output that never
 * sends a newline — a progress bar rewriting itself with \r — would grow it for ever.
 */
const LONGEST_HELD_LINE = 64 * 1024;

/**
 * Masks by whole lines, because a chunk boundary falls wherever the pipe happened to
 * break and half a token matches no rule. A decoder holds a split character for the
 * same reason.
 */
export function maskingTranscript(): Transform {
  const decoder = new StringDecoder('utf8');
  let pending = '';

  return new Transform({
    transform(chunk: Buffer, _encoding, done): void {
      const lines = (pending + decoder.write(chunk)).split(NEWLINE);
      // The tail has no newline yet, so it waits for the rest of its own line.
      pending = lines.pop() ?? '';
      if (lines.length > 0) {
        this.push(lines.map((line) => redactSecrets(line)).join(NEWLINE) + NEWLINE);
      }
      if (pending.length > LONGEST_HELD_LINE) {
        // Nothing is held for ever: it goes out masked, with no newline invented for it.
        this.push(redactSecrets(pending));
        pending = '';
      }
      done();
    },
    flush(done): void {
      // A last line the agent never terminated is still kept, and still masked.
      const last = pending + decoder.end();
      pending = '';
      if (last !== '') this.push(redactSecrets(last));
      done();
    },
  });
}

/**
 * One mask per stream, all teed into the same file, which is the caller's to end once
 * every mask has finished. Its own rather than shared, because a single line buffer would
 * join a half-written stdout line to a stderr chunk and split a token across the rules.
 */
export function maskEach(log: Writable, streams: readonly Readable[]): Transform[] {
  return streams.map((stream) => {
    const mask = maskingTranscript();
    stream.pipe(mask);
    mask.pipe(log, { end: false });
    return mask;
  });
}
