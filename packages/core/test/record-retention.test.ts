import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PendingApprovals } from '../src/gate/pending';
import { Missions } from '../src/session/mission';
import { SessionPauses } from '../src/session/pause';
import { POST_KIND, SessionPosts } from '../src/session/posts';
import { SessionTurns } from '../src/session/session-turns';
import { MEMNOX_HOME } from '../src/config/config';
import { RunTerminals } from '../src/discovery/run-terminal';
import {
  dropOldRecords,
  TRANSCRIPT_SUFFIX,
  TRANSCRIPTS_DIR,
} from '../src/store/record-retention';

const NOW = '2026-10-08T12:00:00.000Z';
const CUTOFF = '2026-09-08T12:00:00.000Z';
const OLD = '2026-08-01T00:00:00.000Z';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'memnox-retention-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const held = {
  sessionId: 'ses_1',
  agent: 'claude-code',
  operation: 'git.push',
  fingerprint: 'f1f1f1f1f1f1',
  reason: 'pushing asks',
};

describe('the records beside the ledger age out with it', () => {
  it('drops what is old and keeps everything still in force', async () => {
    const pending = new PendingApprovals(home);
    await pending.raise(held, OLD, 60_000);
    const live = await pending.raise(
      { ...held, fingerprint: 'f2f2f2f2f2f2' },
      NOW,
      60_000,
    );
    const missions = new Missions(home);
    const closed = await missions.start('Old work', { now: OLD });
    await missions.close(closed.id, OLD);
    const open = await missions.start('Still going', { now: OLD });
    const pauses = new SessionPauses(home);
    const pause = {
      signal: 'error-loop' as const,
      reason: 'loop',
      reached: 5,
      ceiling: 5,
      pausedAt: OLD,
    };
    await pauses.pause({ ...pause, sessionId: 'ses_lifted' });
    await pauses.resume('ses_lifted', 'maya', OLD);
    await pauses.pause({ ...pause, sessionId: 'ses_held' });
    await new SessionTurns(home).ended('ses_old', 'claude-code', OLD);
    await new SessionPosts(home).put({
      kind: POST_KIND.STRUGGLING,
      sessionId: 'ses_old',
      agent: 'claude-code',
      summary: 'struggling',
      at: OLD,
    });

    const dropped = await dropOldRecords({ home, cutoff: CUTOFF, now: NOW });

    expect(dropped).toMatchObject({
      pending: 1,
      posts: 1,
      paused: 1,
      missions: 1,
      turns: 1,
    });
    expect(await pending.read(live.id)).not.toBeNull();
    expect(await missions.read(open.id)).not.toBeNull();
    expect(await pauses.inForce('ses_held')).not.toBeNull();
  });

  it('only counts on a dry run', async () => {
    await new SessionTurns(home).ended('ses_old', 'claude-code', OLD);
    const dropped = await dropOldRecords({
      home,
      cutoff: CUTOFF,
      now: NOW,
      dryRun: true,
    });
    expect(dropped.turns).toBe(1);
    expect(await new SessionTurns(home).read('ses_old')).not.toBeNull();
  });
});

/* `trace` says transcripts share the ledger's retention, and nothing ever deleted one: raw
   agent output kept for good, which is the privacy promise broken without a sound. */
describe('transcripts age out with the ledger', () => {
  async function transcript(sessionId: string, writtenAt: string): Promise<string> {
    const dir = join(home, MEMNOX_HOME, TRANSCRIPTS_DIR);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${sessionId}${TRANSCRIPT_SUFFIX}`);
    await writeFile(path, 'what the agent printed\n');
    const at = new Date(writtenAt);
    await utimes(path, at, at);
    return path;
  }

  const exists = (path: string): Promise<boolean> =>
    stat(path).then(
      () => true,
      () => false,
    );

  it('drops an old transcript and keeps a new one', async () => {
    const old = await transcript('ses_old', OLD);
    const fresh = await transcript('ses_new', NOW);

    const dropped = await dropOldRecords({ home, cutoff: CUTOFF, now: NOW });

    expect(dropped[TRANSCRIPTS_DIR]).toBe(1);
    expect(await exists(old)).toBe(false);
    expect(await exists(fresh)).toBe(true);
  });

  it('counts and deletes nothing on a dry run', async () => {
    const old = await transcript('ses_old', OLD);

    const dropped = await dropOldRecords({
      home,
      cutoff: CUTOFF,
      now: NOW,
      dryRun: true,
    });

    expect(dropped[TRANSCRIPTS_DIR]).toBe(1);
    expect(await exists(old)).toBe(true);
  });

  it('keeps the transcript of a session whose run is still alive, however old', async () => {
    const old = await transcript('ses_live', OLD);
    await new RunTerminals(home).note({
      sessionId: 'ses_live',
      agent: 'claude-code',
      // This test's own process: alive for as long as the assertion below runs.
      pid: process.pid,
      cwd: home,
      startedAt: OLD,
    });

    const dropped = await dropOldRecords({ home, cutoff: CUTOFF, now: NOW });

    expect(dropped[TRANSCRIPTS_DIR]).toBe(0);
    expect(await exists(old)).toBe(true);
  });

  it('is nothing to do on a machine that never kept one', async () => {
    expect(
      (await dropOldRecords({ home, cutoff: CUTOFF, now: NOW }))[TRANSCRIPTS_DIR],
    ).toBe(0);
  });
});
