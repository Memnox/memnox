import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { defaultStart } from '../src/commands/run/start';
import { maskEach, maskingTranscript } from '../src/commands/run/transcript';

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
    /* Bare and full length, so this meets the JWT rule rather than the `token:` one. */
    [
      'a JWT',
      'request failed with eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk\n',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
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

/* One buffer shared between stdout and stderr joined a half-written line to a chunk from
   the other stream, which split a token across what the rules see. */
describe('a mask per stream', () => {
  function collector(): { log: Writable; text: () => string } {
    const chunks: Buffer[] = [];
    const log = new Writable({
      write(chunk: Buffer, _encoding, done): void {
        chunks.push(chunk);
        done();
      },
    });
    return { log, text: () => Buffer.concat(chunks).toString('utf8') };
  }

  it('does not let one stream break a line the other is still writing', async () => {
    const { log, text } = collector();
    const out = new PassThrough();
    const err = new PassThrough();
    const masks = maskEach(log, [out, err]);

    out.write('psql --password=hunt');
    err.write('connecting to db\n');
    out.write('er2hunter -h db\n');
    out.end();
    err.end();
    await Promise.all(masks.map((mask) => once(mask, 'end')));

    expect(text()).not.toContain('er2hunter');
    expect(text()).toContain('[redacted]');
    expect(text()).toContain('connecting to db');
  });
});

describe('output that never sends a newline', () => {
  it('is written out rather than held for ever', () => {
    const mask = maskingTranscript();
    const seen: Buffer[] = [];
    mask.on('data', (piece: Buffer) => seen.push(piece));

    // A progress bar rewriting itself: 200 KiB and not one newline.
    for (let written = 0; written < 200 * 1024; written += 1024) {
      mask.write(Buffer.from('#'.repeat(1024), 'utf8'));
    }

    expect(Buffer.concat(seen).length).toBeGreaterThan(0);
    mask.end();
  });
});

/* `exit` fires while stdout can still be draining, so the tail of a noisy session was
   cut off and a late chunk could reach a mask that had already been ended. */
describe('the transcript a finished run leaves behind', () => {
  it('keeps the last line of output the agent printed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-transcript-'));
    const transcript = join(home, 'sessions', 'ses_1.log');

    const code = await defaultStart(
      process.execPath,
      ['-e', 'for (let i = 0; i < 4000; i += 1) console.log(`line ${i} of output`);'],
      { ...process.env },
      transcript,
    );

    const kept = await readFile(transcript, 'utf8');
    expect(code).toBe(0);
    expect(kept).toContain('line 3999 of output');
    await rm(home, { recursive: true, force: true });
  });
});

/* A command that does not exist fires `error` and then `close` with -2. The child counted
   twice, so the file could close before a mask had flushed, and -2 replaced the 127. */
describe('a command that is not there', () => {
  it('answers 127 and leaves a transcript behind', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-missing-'));
    const transcript = join(home, 'sessions', 'ses_1.log');

    const code = await defaultStart(
      'memnox-no-such-binary',
      [],
      { ...process.env },
      transcript,
    );

    expect(code).toBe(127);
    await expect(readFile(transcript, 'utf8')).resolves.toBe('');
    await rm(home, { recursive: true, force: true });
  });
});
