import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NOTICE_SETTINGS,
  FileNoticeStore,
  NOTICE_OPERATION,
  SqliteEventStore,
  UnusualNotice,
} from '@memnox/core';

import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { registerResumeCommand } from '../src/commands/resume.command';
import { plainStyle } from '../src/style';

const NOW = new Date('2026-09-05T10:00:00.000Z');

async function resume(dir: string, session: string): Promise<RecordedOutput> {
  const out = new RecordedOutput();
  const program = new Command();
  program.exitOverride();
  registerResumeCommand(
    program,
    new CliContext(out, plainStyle),
    () => dir,
    () => NOW,
  );
  await program.parseAsync(['resume', session, '--by', 'dana'], { from: 'user' });
  return out;
}

describe('memnox resume, on a session a tool result put under suspicion', () => {
  it('lifts it, says what it was wary of, and records who lifted it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memnox-resume-'));
    new UnusualNotice({
      store: new FileNoticeStore(dir),
      agent: 'claude-code',
      sessionId: 'ses_w',
      settings: DEFAULT_NOTICE_SETTINGS,
      now: () => NOW,
    }).taint('github.get_issue');

    const out = await resume(dir, 'ses_w');
    expect(out.text).toContain('github.get_issue read like instructions');
    expect(new FileNoticeStore(dir).readSignals('ses_w').taint).toBeUndefined();

    const rows = await SqliteEventStore.forHome(dir).query({ sessionId: 'ses_w' });
    expect(rows.map((row) => [row.operation, row.authorizedBy])).toEqual([
      [NOTICE_OPERATION.TAINT_CLEARED, 'dana'],
    ]);
  });

  it('refuses a session with nothing to lift', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memnox-resume-'));
    await expect(resume(dir, 'ses_none')).rejects.toThrow(/not paused/);
  });
});
