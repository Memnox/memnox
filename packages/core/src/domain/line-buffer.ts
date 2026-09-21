/**
 * Splits a stream into whole newline-delimited lines, holding back the partial one, since
 * a partial write is normal on a pipe and treating it as a message corrupts the stream.
 */
export class LineBuffer {
  private pending = '';

  /** The whole lines this chunk completed. Blank lines are not messages. */
  push(chunk: string): string[] {
    this.pending += chunk;
    const lines = this.pending.split('\n');
    this.pending = lines.pop() ?? '';
    return lines.filter((line) => line.trim().length > 0);
  }
}
