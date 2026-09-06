import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { LeaseRegistry, SESSION_VAR } from '@memnox/core';
import { registerLockCommand } from '../src/commands/lock.command';
import { runCommand } from './cli-harness';

const run = promisify(execFile);
const NOW = new Date('2026-09-05T10:00:00.000Z');

let repo: string;
let home: string;

/** A real repository, because a lease is repository-relative and refuses to guess. */
beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), 'memnox-lock-repo-'));
  await run('git', ['init', '-q'], { cwd: repo });
  await mkdir(join(repo, 'src', 'billing'), { recursive: true });
  await writeFile(join(repo, 'src', 'billing', 'invoice.ts'), 'export {};\n');
}, 30_000);

const lock = async (args: string[], at: Date = NOW) => {
  const previous = { cwd: process.cwd(), session: process.env[SESSION_VAR] };
  process.chdir(repo);
  process.env[SESSION_VAR] = 'ses_test';
  try {
    return await runCommand(
      (program, context) =>
        registerLockCommand(
          program,
          context,
          () => home,
          () => at,
        ),
      args,
    );
  } finally {
    process.chdir(previous.cwd);
    if (previous.session === undefined) delete process.env[SESSION_VAR];
    else process.env[SESSION_VAR] = previous.session;
  }
};

describe('memnox lock', () => {
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'memnox-lock-home-'));
  });

  it('says nothing is held before anybody takes anything', async () => {
    const { out } = await lock(['lock', '--list']);
    expect(out.text).toContain('Nothing is held');
  });

  it('holds exactly the path it was given, and says when it lets go', async () => {
    const { out } = await lock(['lock', 'src/billing/invoice.ts', '--for', '30m']);
    /* Exactly what was named. The directory-scoping rule is the seam's, where ten
       writes must not become ten leases; widening a path a person typed is a lock
       they did not ask for. */
    expect(out.text).toContain('Holding src/billing/invoice.ts');
    // Every lease expires, and the screen that takes one has to say so.
    expect(out.notes.join(' ')).toContain('expires on its own');
  });

  it('shows the holder and what they have been doing, from a third terminal', async () => {
    const { out } = await lock(['lock', '--list'], new Date(NOW.getTime() + 60_000));
    expect(out.text).toContain('src/billing');
    expect(out.text).toContain('held by hand');
  });

  it('refuses a path outside the repository rather than leasing something surprising', async () => {
    await expect(lock(['lock', '../elsewhere'])).rejects.toThrow(
      'outside this repository',
    );
  });

  it('tells a second session who holds it, not merely that it is held', async () => {
    const registry = new LeaseRegistry(home);
    const [held] = await registry.held(new Date(NOW.getTime() + 60_000).toISOString());
    await registry.takeOver(
      held?.id ?? '',
      { agent: 'cursor', sessionId: 'ses_other', pid: process.pid },
      'a test',
      new Date(NOW.getTime() + 120_000).toISOString(),
    );

    const at = new Date(NOW.getTime() + 180_000);
    await expect(lock(['lock', 'src/billing'], at)).rejects.toThrow(
      'held by somebody else',
    );
    const { out } = await lock(['lock', '--list'], at);
    expect(out.text).toContain('cursor');
  });

  it('refuses to release a lease belonging to another session', async () => {
    const registry = new LeaseRegistry(home);
    const [held] = await registry.held(new Date(NOW.getTime() + 180_000).toISOString());
    await expect(lock(['lock', '--release', held?.id ?? ''])).rejects.toThrow(
      'another session',
    );
  });

  it('forgets the records of leases nobody holds', async () => {
    const later = new Date(NOW.getTime() + 5 * 60 * 60_000);
    const { out } = await lock(['lock', '--forget'], later);
    expect(out.text).toContain('Forgot');
    const { out: after } = await lock(['lock', '--list'], later);
    expect(after.text).toContain('Nothing is held');
  });
});

describe('a lease taken by hand outlives the command that took it', () => {
  /* This process exits the moment it has printed. Holding its own pid made every
     hand-taken lease abandoned before the next command could see it — `lock --list`
     answered "nothing is held" one line after taking one, which is the whole command
     not working for the thing it exists to do. */
  it('is still held when a separate command asks', async () => {
    const { out } = await lock(['lock', 'src/billing', '--for', '30m']);
    expect(out.text).toContain('Holding src/billing');

    const { out: listed } = await lock(
      ['lock', '--list'],
      new Date(NOW.getTime() + 1000),
    );
    expect(listed.text).toContain('src/billing');
    expect(listed.text).not.toContain('Nothing is held');
  });

  it('holds a path that does not exist yet rather than widening to the root', async () => {
    const { out } = await lock(['lock', 'docs/not-written-yet', '--for', '30m']);
    expect(out.text).toContain('Holding docs/not-written-yet');
  });
});
