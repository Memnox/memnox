/**
 * `memnox stop`, as the one file every seam reads before it rules: present and unexpired
 * means this machine's protection was turned off on purpose, by somebody, for a reason.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { EnforcementMode } from '../constants/enforcement.constants';
import { isEnforcementMode } from '../domain/enforcement';
import { readJsonFile, writeJsonFile } from '../store/json-records';
import { MEMNOX_HOME } from './config';

/** Beside `config.toml` rather than inside it, so the mode somebody chose is never rewritten. */
export const PROTECTION_STOP_FILE = 'stopped.json';

/** What a seam says it did while stopped, so the row explains an allow no rule decided. */
export const PROTECTION_STOPPED_REASON = 'Memnox protection is stopped on this machine';

export interface ProtectionStop {
  /** When protection went off. */
  at: string;
  /** The person who turned it off, by their login name. */
  by: string;
  reason?: string;
  /** When it comes back by itself. Absent means only `memnox start` brings it back. */
  until?: string;
  /** The mode in force when it stopped, which is the mode `start` comes back to. */
  mode: EnforcementMode;
}

export function protectionStopPath(home: string): string {
  return join(home, MEMNOX_HOME, PROTECTION_STOP_FILE);
}

/** The stop as written, expired or not; null when protection was never stopped. */
export async function readProtectionStop(home: string): Promise<ProtectionStop | null> {
  const held = await readJsonFile<unknown>(protectionStopPath(home));
  return isProtectionStop(held) ? held : null;
}

/** A timed stop whose time is up is over, whether or not anything has cleared it yet. */
export function stopHasEnded(stop: ProtectionStop, now: Date): boolean {
  return stop.until !== undefined && Date.parse(stop.until) <= now.getTime();
}

/**
 * What a seam asks before it rules. An unreadable file reads as not stopped, because a
 * torn write must never be the thing that turns protection off.
 */
export async function protectionStopped(
  home: string,
  now = new Date(),
): Promise<boolean> {
  const stop = await readProtectionStop(home);
  return stop !== null && !stopHasEnded(stop, now);
}

export async function writeProtectionStop(
  home: string,
  stop: ProtectionStop,
): Promise<void> {
  await writeJsonFile(protectionStopPath(home), stop);
}

export async function clearProtectionStop(home: string): Promise<void> {
  await rm(protectionStopPath(home), { force: true });
}

function isProtectionStop(value: unknown): value is ProtectionStop {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['at'] === 'string' &&
    typeof record['by'] === 'string' &&
    isEnforcementMode(record['mode']) &&
    (record['until'] === undefined || typeof record['until'] === 'string')
  );
}
