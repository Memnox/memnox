import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MEMNOX_HOME } from '@memnox/core';

/**
 * What a person calls the agents on their own machine.
 *
 * `agt_claude-code` is what the detector proved and it has to stay the identity,
 * because a name somebody can change is not one a ledger row can be keyed on.
 * So the name is a second field over the top: the id is what everything stores
 * and the name is what everything prints, and the two never compete.
 *
 * Names are local. A machine that renames its own agents and then reports the
 * rename would be asking the control plane to hold one person's vocabulary for
 * a fleet, and the next machine calling a different agent "Backend" would win.
 */

const AGENTS_DIR = 'agents';
const NAMES_FILE = 'names.json';
/** Owner-only, because the file names the agents this person runs and where. */
const OWNER_ONLY = 0o600;

/** Long enough for "Frontend refactor agent", short enough to stay in a column. */
export const NAME_LIMIT = 40;

/** agent id to the name a person gave it. Absent means nobody has named it. */
export type AgentNames = Readonly<Record<string, string>>;

function namesPath(home: string): string {
  return join(home, MEMNOX_HOME, AGENTS_DIR, NAMES_FILE);
}

export async function readNames(home: string): Promise<AgentNames> {
  try {
    const parsed: unknown = JSON.parse(await readFile(namesPath(home), 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return {};
    const kept: Record<string, string> = {};
    for (const [id, name] of Object.entries(parsed as Record<string, unknown>)) {
      // A hand-edited file is untrusted input like any other: keep only strings.
      if (typeof name === 'string' && name.trim() !== '') kept[id] = name.trim();
    }
    return kept;
  } catch {
    // No file is the ordinary case: nobody has named anything yet.
    return {};
  }
}

async function writeNames(home: string, names: AgentNames): Promise<void> {
  const path = namesPath(home);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(names, null, 2)}\n`, {
    encoding: 'utf8',
    mode: OWNER_ONLY,
  });
}

const NAME_REFUSED = {
  EMPTY: 'empty',
  TOO_LONG: 'too_long',
  UNPRINTABLE: 'unprintable',
  TAKEN: 'taken',
} as const;

type Refusal = (typeof NAME_REFUSED)[keyof typeof NAME_REFUSED];

interface NameOutcome {
  ok: boolean;
  name?: string;
  refused?: Refusal;
  because?: string;
}

/**
 * Checked before it is written, because a name is read back into a column and a
 * prompt. A tab or a newline in one would corrupt every screen that prints it,
 * and a duplicate would make `memnox agents status "Backend"` ambiguous.
 */
export function checkName(
  wanted: string,
  agentId: string,
  taken: AgentNames,
): NameOutcome {
  const name = wanted.trim();
  if (name === '') {
    return { ok: false, refused: NAME_REFUSED.EMPTY, because: 'a name cannot be blank' };
  }
  if (name.length > NAME_LIMIT) {
    return {
      ok: false,
      refused: NAME_REFUSED.TOO_LONG,
      because: `a name has to fit in ${NAME_LIMIT} characters`,
    };
  }
  if (CONTROL_CHARACTER.test(name)) {
    return {
      ok: false,
      refused: NAME_REFUSED.UNPRINTABLE,
      because: 'a name cannot hold a tab, a newline or a control character',
    };
  }
  const clash = Object.entries(taken).find(
    ([id, each]) => id !== agentId && same(each, name),
  );
  if (clash !== undefined) {
    return {
      ok: false,
      refused: NAME_REFUSED.TAKEN,
      because: `${clash[0]} is already called "${clash[1]}"`,
    };
  }
  return { ok: true, name };
}

export async function setName(
  home: string,
  agentId: string,
  wanted: string,
): Promise<NameOutcome> {
  const names = await readNames(home);
  const checked = checkName(wanted, agentId, names);
  if (!checked.ok || checked.name === undefined) return checked;
  await writeNames(home, { ...names, [agentId]: checked.name });
  return checked;
}

export async function clearName(home: string, agentId: string): Promise<boolean> {
  const names = await readNames(home);
  if (names[agentId] === undefined) return false;
  const { [agentId]: _dropped, ...rest } = names;
  await writeNames(home, rest);
  return true;
}

/**
 * The name to print: what a person chose, or a readable form of what was detected.
 *
 * Derived from the id rather than from the kind, because the id is what every
 * detector builds out of the product it found and the kind is free to be a
 * category. `agt_claude-code` reads back as "Claude Code" either way.
 */
export function displayName(
  names: AgentNames,
  agent: { id: string; kind: string },
): string {
  const chosen = names[agent.id];
  if (chosen !== undefined) return chosen;
  const from = bare(agent.id);
  return defaultName(from === '' ? agent.kind : from);
}

/** True when this agent is still running under whatever the detector called it. */
export function isDefaultName(names: AgentNames, agent: { id: string }): boolean {
  return names[agent.id] === undefined;
}

/**
 * `claude-code` reads as "Claude Code" and `codex-cli` as "Codex CLI".
 *
 * Derived rather than tabulated, so a detector added tomorrow gets a readable
 * name without anybody remembering to extend a list.
 */
function defaultName(kind: string): string {
  const words = kind
    .split(/[-_\s]+/)
    .filter((word) => word !== '')
    .map((word) =>
      ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : capital(word),
    );
  return words.length === 0 ? kind : words.join(' ');
}

/** A tab or a newline in a name would corrupt every column and prompt that prints it. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** Words a title case pass would otherwise turn into "Cli" and "Mcp". */
const ACRONYMS = new Set(['cli', 'mcp', 'ide', 'api', 'ai']);

function capital(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * One agent, by whatever a person typed.
 *
 * The name they chose comes first, because somebody who renamed an agent is
 * going to type the name. The full id, the id without its prefix and the
 * product all resolve too, so nothing a person can see on a screen fails to
 * work when they type it back.
 */
export function resolveAgent<T extends { id: string; kind: string }>(
  agents: readonly T[],
  names: AgentNames,
  query: string,
): T | null {
  const wanted = query.trim();
  if (wanted === '') return null;
  const byName = agents.find((agent) => same(displayName(names, agent), wanted));
  if (byName !== undefined) return byName;
  const found = agents.find(
    (agent) =>
      same(agent.id, wanted) || same(bare(agent.id), wanted) || same(agent.kind, wanted),
  );
  return found ?? null;
}

/** `agt_claude-code` typed as `claude-code`, which is what is on every other screen. */
function bare(id: string): string {
  return id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : id;
}

const ID_PREFIX = 'agt_';

/** Case and spacing are not identity: "backend coder" is "Backend Coder". */
function same(left: string, right: string): boolean {
  return flat(left) === flat(right);
}

function flat(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}
