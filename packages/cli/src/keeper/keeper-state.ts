/**
 * What the daemon remembers between passes beside `kept.json`: the machine as it last
 * looked, when each agent was first seen, and which dormant agents it already mentioned.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { MEMNOX_HOME, type EnvironmentSnapshot } from '@memnox/core';

import type { DriftBaseline } from '../scan/machine-drift';
import type { AuthorityRecord } from './keep-authority';

export const KEEPER_STATE_FILE = 'keeper.json';

interface KeeperState {
  /** The last look, which the next pass compares against. Names and counts only. */
  baseline: DriftBaseline;
  /** Agent id to the first moment the daemon saw it, which bounds how long it can be silent. */
  firstSeen: Record<string, string>;
  /** Agents already called dormant, so each is mentioned once for each stretch of silence. */
  dormantNoticed: string[];
  /** What each agent could do at the last pass, so authority that grew is said once. */
  authority?: AuthorityRecord;
}

export const FRESH_STATE: KeeperState = {
  baseline: { snapshot: null, credentials: null, definitions: null },
  firstSeen: {},
  dormantNoticed: [],
};

function statePath(home: string): string {
  return join(home, MEMNOX_HOME, KEEPER_STATE_FILE);
}

/** A missing or unreadable file is a daemon that has not looked yet, never an error. */
export async function readKeeperState(home: string): Promise<KeeperState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(statePath(home), 'utf8'));
    return isState(parsed) ? parsed : FRESH_STATE;
  } catch {
    // No file yet is the ordinary state before the daemon's first pass.
    return FRESH_STATE;
  }
}

export async function writeKeeperState(home: string, state: KeeperState): Promise<void> {
  await mkdir(join(home, MEMNOX_HOME), { recursive: true });
  await writeFile(statePath(home), `${JSON.stringify(state)}\n`, 'utf8');
}

/** Called by uninstall beside `forgetKept`, so a machine set up again starts looking afresh. */
export async function forgetKeeperState(home: string): Promise<void> {
  await rm(statePath(home), { force: true });
}

// Shape only: a snapshot that fails to compare is caught by the pass, never trusted here.
function isState(value: unknown): value is KeeperState {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const baseline = record['baseline'];
  return (
    baseline !== null &&
    typeof baseline === 'object' &&
    isSnapshotOrNull((baseline as Record<string, unknown>)['snapshot']) &&
    typeof record['firstSeen'] === 'object' &&
    record['firstSeen'] !== null &&
    Array.isArray(record['dormantNoticed'])
  );
}

function isSnapshotOrNull(value: unknown): value is EnvironmentSnapshot | null {
  if (value === null) return true;
  if (typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record['agents']) && Array.isArray(record['servers']);
}
