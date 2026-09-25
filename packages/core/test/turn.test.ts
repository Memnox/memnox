import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOTICE_MODE } from '../src/notice/notice.constants';
import { FileNoticeStore } from '../src/notice/notice-store';
import { DEFAULT_NOTICE_SETTINGS, UnusualNotice } from '../src/notice/unusual-notice';
import { emptySignals } from '../src/notice/notice-state';
import { mayTurn, turnStep, TURN_AFTER_READS } from '../src/notice/turn';

const allow = { effect: 'allow' as const, reason: 'no rule matched', signals: [] };

async function noticing(): Promise<UnusualNotice> {
  const home = await mkdtemp(join(tmpdir(), 'memnox-turn-'));
  return new UnusualNotice({
    store: new FileNoticeStore(home),
    agent: 'claude-code',
    sessionId: 'ses_1',
    settings: { ...DEFAULT_NOTICE_SETTINGS, mode: NOTICE_MODE.ENFORCE, warmupDays: 0 },
    now: () => new Date('2026-09-25T10:00:00.000Z'),
  });
}

describe('an investigation that turns into a change', () => {
  it('asks once, at the first change after enough reads of a system', async () => {
    const notice = await noticing();
    for (const action of [
      'gh.pr-view',
      'railway.logs',
      'mcp.stripe.retrieve_payment_intent',
    ]) {
      expect(notice.consider({ action, toolClass: 'read' }, allow).effect).toBe('allow');
    }
    const refund = notice.consider(
      { action: 'mcp.stripe.create_refund', toolClass: 'write' },
      allow,
    );
    expect(refund.effect).toBe('ask');
    expect(refund.reason).toContain('first change it makes');
    const again = notice.consider(
      { action: 'gh.pr-comment', toolClass: 'communication' },
      allow,
    );
    expect(again.reason).not.toContain('first change it makes');
  });

  it('leaves a change alone when the session had barely looked', async () => {
    const notice = await noticing();
    notice.consider({ action: 'gh.pr-view', toolClass: 'read' }, allow);
    const merge = notice.consider({ action: 'gh.pr-merge', toolClass: 'write' }, allow);
    expect(merge.reason).not.toContain('first change it makes');
  });

  it('counts neither local work nor a web fetch as investigating a system', () => {
    expect(mayTurn({ action: 'filesystem.read', toolClass: 'read' })).toBe(false);
    expect(mayTurn({ action: 'git.log', toolClass: 'read' })).toBe(false);
    expect(mayTurn({ action: 'http.request', toolClass: 'read' })).toBe(false);
    expect(mayTurn({ action: 'http.request', toolClass: 'write' })).toBe(true);
    expect(mayTurn({ action: 'filesystem.write', toolClass: 'write' })).toBe(false);
  });

  it('stops counting once it has enough', () => {
    const counted = { ...emptySignals(), outsideReads: TURN_AFTER_READS };
    expect(turnStep({ action: 'gh.pr-view', toolClass: 'read' }, counted)).toBeNull();
  });
});
