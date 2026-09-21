import { digest } from '../domain/digest';
import { verbTableNames } from '../verbs/tables';
import { declaredList, parseFrontmatter } from './frontmatter';
import { listAt, parseTomlTables } from './detectors/toml-tables';
import type { MachineReader } from './ports';

/**
 * Skills and installed personas treated like deployments: read for their reach, and one
 * reaching further than the version somebody accepted is held until they look.
 */

/** A skill the agent wrote for itself, or a persona somebody installed; both change tomorrow. */
export const DEFINITION_KIND = {
  SKILL: 'skill',
  AGENT: 'agent',
} as const;

export type DefinitionKind = (typeof DEFINITION_KIND)[keyof typeof DEFINITION_KIND];

/**
 * How much a definition may touch, as its own file states it. Three answers, because a
 * subagent with no `tools` key inherits every tool, the widest grant a file can carry.
 */
export const GRANT = {
  /** The file names the tools it may use. */
  DECLARED: 'declared',
  /** The file names none, and on this harness that means every tool in the session. */
  INHERITS: 'inherits',
  /** This shape carries no grant anything here knows how to read. */
  UNREAD: 'unread',
} as const;

export type GrantKind = (typeof GRANT)[keyof typeof GRANT];

export interface ToolGrant {
  kind: GrantKind;
  /** Named tools, and empty for every kind but `DECLARED`. */
  tools: string[];
}

export const SKILL_STANDING = {
  /** Seen before, unchanged, and somebody accepted it. */
  KNOWN: 'known',
  /** Never seen here before. */
  NEW: 'new',
  /** Changed, and what it can reach is the same or smaller. */
  CHANGED: 'changed',
  /** Changed, and it reaches further than the version somebody accepted. */
  WIDENED: 'widened',
} as const;

export type SkillStanding = (typeof SKILL_STANDING)[keyof typeof SKILL_STANDING];

export interface DiscoveredSkill {
  id: string;
  name: string;
  path: string;
  /** Which agent's directory it was found in. */
  agent: string;
  /** Written for itself, or installed by somebody. */
  kind: DefinitionKind;
  /** What its own frontmatter says it may use, which is not the same as what it names. */
  grant: ToolGrant;
  /** Command-line tools it names, which is evidence and not proof that it runs them. */
  reaches: string[];
  /** Content digest, so a change is detected without keeping the text. */
  digest: string;
}

export interface SkillFinding extends DiscoveredSkill {
  standing: SkillStanding;
  /** What it reaches now and did not before. The whole reason to hold it. */
  gained: string[];
  /** Its own grant got wider, including a fence removed, which the text may not show. */
  widerGrant: boolean;
}

/**
 * Where each agent keeps them, and never an unpublished layout. `nested` is for skills
 * grouped under a category directory, as Hermes does.
 */
const SKILL_ROOTS: readonly { agent: string; path: string; nested?: true }[] = [
  { agent: 'claude-code', path: '.claude/skills' },
  { agent: 'codex', path: '.codex/skills' },
  { agent: 'cursor', path: '.cursor/skills' },
  { agent: 'hermes', path: '.hermes/skills', nested: true },
  // Codex's directory, whoever wrote into it: Ruflo keeps no skills of its own.
  { agent: 'codex', path: '.agents/skills' },
];

const SKILL_FILES = ['SKILL.md', 'skill.md', 'index.md'];

/**
 * Where each harness keeps installed personas, one flat file each. `inherits` is true only
 * where the vendor documents that an absent grant means every tool.
 */
const AGENT_ROOTS: readonly {
  agent: string;
  path: string;
  suffix: string;
  inherits: boolean;
}[] = [
  { agent: 'claude-code', path: '.claude/agents', suffix: '.md', inherits: true },
  { agent: 'codex', path: '.codex/agents', suffix: '.toml', inherits: false },
  { agent: 'copilot', path: '.github/agents', suffix: '.md', inherits: false },
  { agent: 'copilot', path: '.copilot/agents', suffix: '.md', inherits: false },
  { agent: 'gemini-cli', path: '.gemini/agents', suffix: '.md', inherits: false },
  { agent: 'qwen', path: '.qwen/agents', suffix: '.md', inherits: true },
  { agent: 'zcode', path: '.zcode/agents', suffix: '.md', inherits: true },
  { agent: 'opencode', path: '.config/opencode/agents', suffix: '.md', inherits: false },
];

/** The key each harness writes its tool grant under. */
const GRANT_KEYS: readonly string[] = ['tools', 'allowed-tools'];

export async function discoverSkills(
  reader: MachineReader,
  roots: readonly string[] = [reader.homeDir()],
): Promise<DiscoveredSkill[]> {
  const binaries = verbTableNames();
  const found: DiscoveredSkill[] = [];

  for (const root of roots) {
    for (const { agent, path, nested } of SKILL_ROOTS) {
      const dir = `${root}/${path}`;
      // Listed rather than probed for, since a directory that lists nothing is absent.
      for (const name of childrenOf(await reader.list(dir))) {
        const here = `${dir}/${name}`;
        const text = await readSkill(reader, here);
        if (text !== null) {
          found.push(skillAt({ agent, name, path: here, text, binaries }));
          continue;
        }
        if (nested !== true) continue;
        // A category directory: each skill is named by its own directory, not the group.
        for (const child of childrenOf(await reader.list(here))) {
          const inner = `${here}/${child}`;
          const body = await readSkill(reader, inner);
          if (body === null) continue;
          found.push(skillAt({ agent, name: child, path: inner, text: body, binaries }));
        }
      }
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Personas installed into an agent's directory, read for the grant their header carries,
 * because on a harness that inherits, one declaring no tools runs with everything.
 */
export async function discoverAgents(
  reader: MachineReader,
  roots: readonly string[] = [reader.homeDir()],
): Promise<DiscoveredSkill[]> {
  const binaries = verbTableNames();
  const found: DiscoveredSkill[] = [];

  for (const root of roots) {
    for (const { agent, path, suffix, inherits } of AGENT_ROOTS) {
      const dir = `${root}/${path}`;
      for (const name of childrenOf(await reader.list(dir))) {
        if (!name.endsWith(suffix)) continue;
        const here = `${dir}/${name}`;
        const text = await reader.read(here);
        // A directory, or a file that will not read: absent rather than an error.
        if (text === null) continue;
        found.push(
          skillAt({
            agent,
            name: name.slice(0, -suffix.length),
            path: here,
            text,
            binaries,
            kind: DEFINITION_KIND.AGENT,
            grant: grantOf(text, suffix, inherits),
          }),
        );
      }
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/** Both kinds through one screen: they are the same question about the same machine. */
export async function discoverDefinitions(
  reader: MachineReader,
  roots: readonly string[] = [reader.homeDir()],
): Promise<DiscoveredSkill[]> {
  const [skills, agents] = await Promise.all([
    discoverSkills(reader, roots),
    discoverAgents(reader, roots),
  ]);
  return [...skills, ...agents].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The tool grant a definition states in its own header. An absent key is `INHERITS` only
 * where the harness documents it, and `UNREAD`, which is no evidence, everywhere else.
 */
export function grantOf(text: string, suffix: string, inherits: boolean): ToolGrant {
  const declared = suffix === '.toml' ? tomlGrant(text) : yamlGrant(text);
  if (declared !== null) return { kind: GRANT.DECLARED, tools: declared };
  return { kind: inherits ? GRANT.INHERITS : GRANT.UNREAD, tools: [] };
}

function yamlGrant(text: string): string[] | null {
  const matter = parseFrontmatter(text);
  for (const key of GRANT_KEYS) {
    const declared = declaredList(matter, key);
    if (declared !== null) return declared;
  }
  return null;
}

function tomlGrant(text: string): string[] | null {
  const parsed = parseTomlTables(text);
  const root = parsed.tables.get('');
  for (const key of GRANT_KEYS) {
    // Presence is asked before the value: `listAt` reports an absent key as empty.
    if (root?.has(key) === true) return listAt(parsed, '', key);
  }
  return null;
}

/** Immediate children, so a reader returning deeper paths cannot produce a skill called `deploy/SKILL.md`. */
function childrenOf(entries: readonly string[]): string[] {
  return [...new Set(entries.map((each) => each.split('/')[0] ?? each))].filter(
    (each) => each !== '',
  );
}

interface SkillInput {
  agent: string;
  name: string;
  path: string;
  text: string;
  binaries: readonly string[];
  /** A skill unless said otherwise, with a grant nothing here reads. */
  kind?: DefinitionKind;
  grant?: ToolGrant;
}

/** Characters of the path digest kept in a skill id. */
const SKILL_ID_LENGTH = 12;

function skillAt(input: SkillInput): DiscoveredSkill {
  const { agent, path, text } = input;
  return {
    // Keyed on the path, or two skills of the same name under one agent collide.
    id: `skl_${digest(`${agent}:${path}`).slice(0, SKILL_ID_LENGTH)}`,
    name: input.name,
    path,
    agent,
    kind: input.kind ?? DEFINITION_KIND.SKILL,
    grant: input.grant ?? { kind: GRANT.UNREAD, tools: [] },
    reaches: reachOf(text, input.binaries),
    digest: digest(text),
  };
}

async function readSkill(reader: MachineReader, dir: string): Promise<string | null> {
  for (const file of SKILL_FILES) {
    const text = await reader.read(`${dir}/${file}`);
    if (text !== null) return text;
  }
  // A directory with no skill file in it is not a skill, which is not an error.
  return null;
}

/**
 * Binaries the text names, matched whole, and only those with a verb table, because a
 * name with no table behind it says nothing enforceable.
 */
export function reachOf(text: string, binaries: readonly string[]): string[] {
  const lowered = text.toLowerCase();
  return binaries.filter((binary) => new RegExp(`\\b${binary}\\b`).test(lowered)).sort();
}

export interface AcceptedSkill {
  id: string;
  digest: string;
  reaches: string[];
  acceptedAt: string;
  acceptedBy: string;
  /** Optional: a record written before grants were read carries none, and is not a widening. */
  grant?: ToolGrant;
}

/**
 * What changed since somebody last looked. A new skill is reported and not held, since
 * an agent that cannot write its first one gets this switched off.
 */
export function reviewSkills(
  found: readonly DiscoveredSkill[],
  accepted: readonly AcceptedSkill[],
): SkillFinding[] {
  const known = new Map(accepted.map((each) => [each.id, each]));
  return found.map((skill) => {
    const before = known.get(skill.id);
    if (before === undefined) {
      return {
        ...skill,
        standing: SKILL_STANDING.NEW,
        gained: skill.reaches,
        widerGrant: false,
      };
    }
    if (before.digest === skill.digest) {
      return { ...skill, standing: SKILL_STANDING.KNOWN, gained: [], widerGrant: false };
    }
    const gained = skill.reaches.filter((each) => !before.reaches.includes(each));
    const widerGrant = grantWidened(before.grant, skill.grant);
    return {
      ...skill,
      standing:
        gained.length > 0 || widerGrant ? SKILL_STANDING.WIDENED : SKILL_STANDING.CHANGED,
      gained,
      widerGrant,
    };
  });
}

/**
 * Whether the file's grant got wider than the one somebody accepted. Losing the key is
 * the case worth catching: four named tools becoming none is the largest change.
 */
export function grantWidened(before: ToolGrant | undefined, now: ToolGrant): boolean {
  // Accepted before grants were read: there is nothing to compare, so nothing is held.
  if (before === undefined) return false;
  if (now.kind === GRANT.INHERITS) return before.kind !== GRANT.INHERITS;
  if (now.kind !== GRANT.DECLARED || before.kind !== GRANT.DECLARED) return false;
  return now.tools.some((each) => !before.tools.includes(each));
}

/**
 * How many definitions arriving together stop being somebody's own work: a dozen in one
 * directory between two scans is an install nobody read.
 */
export const BULK_ARRIVAL = 12;

export interface Arrival {
  agent: string;
  /** The directory they all landed in. */
  root: string;
  definitions: SkillFinding[];
  /** How many of them run with every tool in the session. */
  inheriting: number;
}

/** Rosters that arrived at once, as one row each: the finding is the install, not any one file. */
export function bulkArrivals(
  findings: readonly SkillFinding[],
  threshold: number = BULK_ARRIVAL,
): Arrival[] {
  const groups = new Map<string, SkillFinding[]>();
  for (const finding of findings) {
    if (finding.standing !== SKILL_STANDING.NEW) continue;
    if (finding.kind !== DEFINITION_KIND.AGENT) continue;
    const key = `${finding.agent}\u0000${rootOf(finding.path)}`;
    groups.set(key, [...(groups.get(key) ?? []), finding]);
  }

  const arrivals: Arrival[] = [];
  for (const [key, definitions] of groups) {
    if (definitions.length < threshold) continue;
    arrivals.push({
      agent: definitions[0]?.agent ?? '',
      root: key.split('\u0000')[1] ?? '',
      definitions,
      inheriting: definitions.filter((each) => each.grant.kind === GRANT.INHERITS).length,
    });
  }
  return arrivals.sort((a, b) => b.definitions.length - a.definitions.length);
}

function rootOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at === -1 ? path : path.slice(0, at);
}

/**
 * Held until a person looks: a definition reaching further than the accepted version,
 * or a roster that arrived all at once. `NEW` alone is never held.
 */
export function quarantined(
  findings: readonly SkillFinding[],
  threshold: number = BULK_ARRIVAL,
): SkillFinding[] {
  const arrived = new Set(
    bulkArrivals(findings, threshold).flatMap((arrival) =>
      arrival.definitions.map((each) => each.id),
    ),
  );
  return findings.filter(
    (each) => each.standing === SKILL_STANDING.WIDENED || arrived.has(each.id),
  );
}

/** What its own header says it may use, in the words the distinction needs. */
export function describeGrant(grant: ToolGrant): string {
  if (grant.kind === GRANT.INHERITS) return 'inherits every tool in the session';
  if (grant.kind === GRANT.UNREAD) return 'declares no tools this reads';
  if (grant.tools.length === 0) return 'declares no tools at all';
  return `declares ${grant.tools.join(', ')}`;
}

export function describeSkill(finding: SkillFinding): string {
  const reach =
    finding.reaches.length === 0
      ? 'names no tool this knows'
      : `names ${finding.reaches.join(', ')}`;
  // A grant is what the file states and a name in prose is only evidence, so they stay apart.
  const grant = describeGrant(finding.grant);
  const states = finding.kind === DEFINITION_KIND.AGENT ? `${grant}, ${reach}` : reach;
  if (finding.standing !== SKILL_STANDING.WIDENED) return `${finding.name}: ${states}`;

  // What got wider goes in one clause or the other, and saying it twice reads as noise.
  const wider = finding.widerGrant ? [...finding.gained, grant] : finding.gained;
  return `${finding.name} now also ${wider.join(', ')}: ${finding.widerGrant ? reach : states}`;
}
