/**
 * What the agent printed, on its way to the transcript with its credentials masked. The
 * terminal still sees the stream untouched; only the copy that stays on disk is rewritten.
 */
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import { redactSecrets } from '@memnox/core';

const NEWLINE = '\n';

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
