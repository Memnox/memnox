import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { MEMNOX_HOME, readJsonFile, writeJsonFile } from '@memnox/core';

/**
 * The agents somebody was offered on this machine and said no to, so the workspace can
 * tell a declined agent from one nobody asked about. Kept apart from onboarding records,
 * since an `OnboardRecord` means a credential was minted.
 */

const AGENTS_DIR = 'agents';
const DECLINED_FILE = 'declined.json';

/** agent id to when somebody said no. Absent means nobody has been asked. */
export type Declined = Readonly<Record<string, string>>;

function declinedPath(home: string): string {
  return join(home, MEMNOX_HOME, AGENTS_DIR, DECLINED_FILE);
}

export async function readDeclined(home: string): Promise<Declined> {
  const parsed = await readJsonFile<unknown>(declinedPath(home));
  if (parsed === null || typeof parsed !== 'object') return {};
  const kept: Record<string, string> = {};
  // Narrowed to an object above, and every value is checked below.
  for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
    // A hand-edited file is untrusted input like any other: keep only dates.
    if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) kept[id] = at;
  }
  return kept;
}

/** Somebody was asked about this agent here and said no. */
export async function declineAgent(
  home: string,
  agentId: string,
  at: string = new Date().toISOString(),
): Promise<void> {
  await writeJsonFile(declinedPath(home), {
    ...(await readDeclined(home)),
    [agentId]: at,
  });
}

/** The question is open again, because the agent was onboarded after all. */
export async function undecline(home: string, agentId: string): Promise<boolean> {
  const declined = await readDeclined(home);
  if (declined[agentId] === undefined) return false;
  const { [agentId]: _answered, ...rest } = declined;
  await writeJsonFile(declinedPath(home), rest);
  return true;
}

/** Every no on this machine, forgotten on a move between control planes, since it answered the old one. */
export async function forgetDeclined(home: string): Promise<number> {
  const declined = await readDeclined(home);
  const count = Object.keys(declined).length;
  if (count === 0) return 0;
  await rm(declinedPath(home), { force: true });
  return count;
}
