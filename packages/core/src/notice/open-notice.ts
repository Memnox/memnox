/**
 * How a seam gets its notice: the settings from this machine's config, the files under the
 * Memnox home, and the ledger for the rows a taint leaves. One function, so seams agree.
 */
import { readFile } from 'node:fs/promises';

import { DEFAULT_CONFIG, parseConfig, type MemnoxConfig } from '../config/config';
import { configPathFor } from '../config/config-store';
import { ENFORCEMENT_MODE } from '../constants/enforcement.constants';
import type { MemnoxEvent } from '../event/event';
import { openLedger, UNNAMED_AGENT } from '../event/seam-row';
import { NOTICE_MODE, type NoticeMode } from './notice.constants';
import type { Taint } from './notice-state';
import { FileNoticeStore } from './notice-store';
import { taintClearedRow } from './taint-row';
import {
  DEFAULT_NOTICE_SETTINGS,
  UnusualNotice,
  type NoticeSettings,
} from './unusual-notice';

export interface NoticeIdentity {
  agent: string;
  /** The session `memnox run` named, which every seam of one run shares. */
  sessionId?: string;
}

export async function openNotice(
  home: string,
  identity: NoticeIdentity,
): Promise<UnusualNotice> {
  const config = await readConfigQuietly(home);
  return new UnusualNotice({
    store: new FileNoticeStore(home),
    agent: identity.agent,
    ...(identity.sessionId === undefined ? {} : { sessionId: identity.sessionId }),
    settings: noticeSettingsFrom(config),
    home,
    journal: ledgerJournal(home),
  });
}

export interface TaintClearing {
  sessionId: string;
  /** The person lifting it, who the row names. */
  by: string;
  now?: () => Date;
}

/** A person lifting a session's suspicion, as `memnox resume` does, with the row awaited. */
export async function clearSessionTaint(
  home: string,
  clearing: TaintClearing,
): Promise<Taint | null> {
  const at = (clearing.now ?? ((): Date => new Date()))();
  const notice = new UnusualNotice({
    store: new FileNoticeStore(home),
    agent: UNNAMED_AGENT,
    sessionId: clearing.sessionId,
    settings: DEFAULT_NOTICE_SETTINGS,
    now: () => at,
  });
  const taint = notice.clearTaint(clearing.by);
  const sink = openLedger(home);
  if (taint === null || sink === null) return taint;
  const row = { sessionId: clearing.sessionId, agent: UNNAMED_AGENT, taint };
  await sink.append(taintClearedRow({ ...row, at: at.toISOString(), by: clearing.by }));
  return taint;
}

/** The machine's mode decides whether a notice asks or only records; the switch turns it off. */
export function noticeSettingsFrom(config: MemnoxConfig): NoticeSettings {
  return {
    ...DEFAULT_NOTICE_SETTINGS,
    mode: config.noticeUnusual ? noticeModeFor(config.mode) : NOTICE_MODE.OFF,
    warmupDays: config.noticeWarmupDays,
  };
}

function noticeModeFor(mode: MemnoxConfig['mode']): NoticeMode {
  if (mode === ENFORCEMENT_MODE.ENFORCE) return NOTICE_MODE.ENFORCE;
  if (mode === ENFORCEMENT_MODE.OFF) return NOTICE_MODE.OFF;
  // Observe and advise both let the action run, so a notice there is only recorded.
  return NOTICE_MODE.OBSERVE;
}

/** Never created here: a seam reading settings must not be what writes the file. */
async function readConfigQuietly(home: string): Promise<MemnoxConfig> {
  try {
    return parseConfig(await readFile(configPathFor(home), 'utf8'));
  } catch {
    // No config yet is a first run, and a first run reads the defaults.
    return { ...DEFAULT_CONFIG };
  }
}

/** Opened only when a taint changes, which is rare, so an ordinary call opens nothing. */
function ledgerJournal(home: string): (event: MemnoxEvent) => void {
  return (event) => {
    const sink = openLedger(home);
    if (sink === null) return;
    void sink.append(event).catch(() => undefined);
  };
}
