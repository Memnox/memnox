import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENT_ID_PREFIX, MEMNOX_HOME, readJsonFile, writeJsonFile } from '@memnox/core';

/**
 * What a person calls the agents on their own machine. The id is the identity, because a
 * name somebody can change cannot key a ledger row: ids are stored, names are printed.
 */

const AGENTS_DIR = 'agents';
const NAMES_FILE = 'names.json';

/** Long enough for "Frontend refactor agent", short enough to stay in a column. */
export const NAME_LIMIT = 40;

/** agent id to the name a person gave it. Absent means nobody has named it. */
export type AgentNames = Readonly<Record<string, string>>;

function namesPath(home: string): string {
  return join(home, MEMNOX_HOME, AGENTS_DIR, NAMES_FILE);
}

export async function readNames(home: string): Promise<AgentNames> {
  const parsed = await readJsonFile<unknown>(namesPath(home));
  if (parsed === null || typeof parsed !== 'object') return {};
  const kept: Record<string, string> = {};
  // Narrowed to an object above, and every value is checked below.
  for (const [id, name] of Object.entries(parsed as Record<string, unknown>)) {
    // A hand-edited file is untrusted input like any other: keep only strings.
    if (typeof name === 'string' && name.trim() !== '') kept[id] = name.trim();
  }
  return kept;
}

async function writeNames(home: string, names: AgentNames): Promise<void> {
  await writeJsonFile(namesPath(home), names);
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
 * Checked before it is written, because a control character would corrupt every screen
 * that prints it and a duplicate would make `memnox agents status "Backend"` ambiguous.
 */
export function checkName(
  wanted: string,
  agentId: string,
  taken: AgentNames,
): NameOutcome {
  const name = wanted.trim();
  const refused = refusalOf(name);
  if (refused !== null) return refused;
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

/** Why this name cannot be anybody's, whatever else is taken. */
function refusalOf(name: string): NameOutcome | null {
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
  return null;
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

/** Every name on this machine, forgotten on a move between control planes, since names are one workspace's vocabulary. */
export async function forgetNames(home: string): Promise<number> {
  const names = await readNames(home);
  const count = Object.keys(names).length;
  if (count === 0) return 0;
  await rm(namesPath(home), { force: true });
  return count;
}

export async function clearName(home: string, agentId: string): Promise<boolean> {
  const names = await readNames(home);
  if (names[agentId] === undefined) return false;
  const { [agentId]: _dropped, ...rest } = names;
  await writeNames(home, rest);
  return true;
}

/**
 * The name to print: what a person chose, or a readable form of the id, which every
 * detector builds from the product while the kind may be a category.
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

/**
 * The workspace as a sentence can carry it: a short name reads in prose and thirty-six
 * characters of hex does not, so length is the test rather than the UUID shape.
 */
export function workspaceShown(workspaceId: string): string {
  const id = workspaceId.trim();
  if (id === '' || id.length > WORKSPACE_READABLE) return 'your workspace';
  return id;
}

/** Long enough for a name somebody chose, short enough to sit inside a sentence. */
const WORKSPACE_READABLE = 24;

/** True when this agent is still running under whatever the detector called it. */
export function isDefaultName(names: AgentNames, agent: { id: string }): boolean {
  return names[agent.id] === undefined;
}

/**
 * `claude-code` reads as "Claude Code" and `codex-cli` as "Codex CLI", derived rather
 * than tabulated so a new detector needs no list extended.
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
 * One agent, by whatever a person typed: the chosen name first, then the full id, the
 * id without its prefix, and the product, so nothing on a screen fails when typed back.
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
  return id.startsWith(AGENT_ID_PREFIX) ? id.slice(AGENT_ID_PREFIX.length) : id;
}

/** Case and spacing are not identity: "backend coder" is "Backend Coder". */
function same(left: string, right: string): boolean {
  return flat(left) === flat(right);
}

function flat(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}
