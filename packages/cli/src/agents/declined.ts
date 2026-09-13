import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MEMNOX_HOME } from '@memnox/core';

/**
 * The agents somebody was offered on this machine and said no to.
 *
 * A guided run asks per agent and takes no for an answer, and until this existed
 * that answer lived for exactly as long as the terminal did. The scan kept
 * reporting every agent it found, so the census carried Claude Desktop to the
 * workspace looking identical to one nobody had ever been asked about, and the
 * console offered it for approval as though the question were still open. It
 * was not: somebody had answered it.
 *
 * So a no is written down and carried, rather than turned into silence. The
 * agent stays in the census, because it is still on the machine and can still
 * reach `~/.ssh` whether or not Memnox governs it, and an estate page that
 * dropped it would be the screen a person trusts most telling a comfortable
 * lie. What travels with it is the decision: this was offered here and left
 * alone.
 *
 * Kept beside the onboarding records rather than inside one, because an
 * `OnboardRecord` means a credential was minted and a config was rewritten, and
 * a decline is the absence of both.
 */

const AGENTS_DIR = 'agents';
const DECLINED_FILE = 'declined.json';
/** Owner-only, like everything else here: it names the agents this person runs. */
const OWNER_ONLY = 0o600;

/** agent id to when somebody said no. Absent means nobody has been asked. */
export type Declined = Readonly<Record<string, string>>;

function declinedPath(home: string): string {
  return join(home, MEMNOX_HOME, AGENTS_DIR, DECLINED_FILE);
}

export async function readDeclined(home: string): Promise<Declined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(declinedPath(home), 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return {};
    const kept: Record<string, string> = {};
    for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
      // A hand-edited file is untrusted input like any other: keep only strings.
      if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) kept[id] = at;
    }
    return kept;
  } catch {
    // No file is the ordinary case: nobody has declined anything here.
    return {};
  }
}

async function write(home: string, declined: Declined): Promise<void> {
  const path = declinedPath(home);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(declined, null, 2)}\n`, {
    encoding: 'utf8',
    mode: OWNER_ONLY,
  });
}

/** Somebody was asked about this agent here and said no. */
export async function declineAgent(
  home: string,
  agentId: string,
  at: string = new Date().toISOString(),
): Promise<void> {
  await write(home, { ...(await readDeclined(home)), [agentId]: at });
}

/**
 * The question is open again, because somebody answered it the other way.
 *
 * Called where an agent is onboarded rather than only where setup asks, so a
 * later `memnox agents onboard` clears a no from last week. A row that said
 * "left alone" about an agent holding a credential we minted is the one thing
 * this file must never produce.
 */
export async function undecline(home: string, agentId: string): Promise<boolean> {
  const declined = await readDeclined(home);
  if (declined[agentId] === undefined) return false;
  const { [agentId]: _answered, ...rest } = declined;
  await write(home, rest);
  return true;
}

/**
 * Every no on this machine, forgotten.
 *
 * For a move between control planes, which is the one case where they are all
 * wrong at once: the question "should this workspace govern this agent" was
 * answered about a workspace this machine is leaving, and carrying the answer
 * into the next one would report a decision nobody there ever made.
 */
export async function forgetDeclined(home: string): Promise<number> {
  const declined = await readDeclined(home);
  const count = Object.keys(declined).length;
  if (count === 0) return 0;
  await rm(declinedPath(home), { force: true });
  return count;
}
