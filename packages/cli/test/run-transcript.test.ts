import { describe, expect, it } from 'vitest';
import { maskingTranscript } from '../src/commands/run/transcript';

/* The transcript is read back by `memnox claims` and `memnox trace`, so a credential the
   agent printed used to reach a screen from disk long after the session ended. */

/** What the mask wrote, for input delivered as the chunks a pipe would really hand over. */
async function through(chunks: readonly (string | Buffer)[]): Promise<string> {
  const mask = maskingTranscript();
  const written: Buffer[] = [];
  mask.on('data', (piece: Buffer) => written.push(piece));
  const closed = new Promise((resolve) => mask.on('end', resolve));
  for (const chunk of chunks)
    mask.write(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  mask.end();
  await closed;
  return Buffer.concat(written).toString('utf8');
}

describe('the transcript a session keeps', () => {
  it.each([
    ['an AWS key id', 'aws_access_key_id AKIAABCDEFGHIJKLMNOP\n', 'AKIAABCDEFGHIJKLMNOP'],
    [
      'a JWT',
      'token: eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4\n',
      'eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4',
    ],
    ['a password flag', 'psql --password=hunter2hunter -h db\n', 'hunter2hunter'],
    [
      'a GitHub token',
      'echo ghp_abcdefghijklmnopqrstuvwxyz0123\n',
      'ghp_abcdefghijklmnopqrstuvwxyz0123',
    ],
    ['a URL password', 'DATABASE_URL=postgres://app:s3cr3tpw@db:5432/app\n', 's3cr3tpw'],
    [
      'a bearer header',
      'curl -H "Authorization: Bearer abcdefghijklmnop"\n',
      'abcdefghijklmnop',
    ],
  ])('keeps no raw value for %s', async (_what, printed, secret) => {
    const kept = await through([printed]);
    expect(kept).not.toContain(secret);
    expect(kept).toContain('[redacted]');
  });

  it('masks a credential split across two chunks, where the pipe happened to break', async () => {
    const kept = await through(['psql --password=hunt', 'er2hunter -h db\n']);
    expect(kept).not.toContain('hunter2hunter');
    expect(kept).toContain('[redacted]');
  });

  it('keeps a last line the agent never terminated, masked', async () => {
    const kept = await through(['deploy --token=abcd1234efgh5678']);
    expect(kept).not.toContain('abcd1234efgh5678');
    expect(kept).toContain('[redacted]');
  });

  it('leaves ordinary output exactly as it was printed', async () => {
    const printed = 'running 3 tests\nall passed\n';
    expect(await through([printed])).toBe(printed);
  });

  it('keeps a character whose bytes arrived in two chunks', async () => {
    const snowman = Buffer.from('☃', 'utf8');
    const kept = await through([snowman.subarray(0, 1), snowman.subarray(1), '\n']);
    expect(kept).toBe('☃\n');
  });

  it('holds a line until its newline, so nothing is masked half-formed', async () => {
    const kept = await through(['ready\n', 'still going']);
    expect(kept).toBe('ready\nstill going');
  });
});
