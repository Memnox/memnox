import { digest } from '../domain/digest';
import { verbTableNames } from '../verbs/tables';
import { declaredList, parseFrontmatter } from './frontmatter';
import { listAt, parseTomlTables } from './detectors/toml-tables';
import type { MachineReader } from './ports';

/**
 * A skill an agent taught itself, treated like a deployment.
 *
 * An agent that writes its own skills gets more powerful between one run and the next,
 * and nobody decided that it should. The dangerous case is not a skill that is
 * obviously wrong — it is one that quietly reaches further than the last version:
 * yesterday it edited files, today it also runs `kubectl`.
 *
 * So a skill is read for what it can reach, and a skill whose reach has grown is held
 * until somebody has looked at it. Nothing here interprets what a skill is *for*: that
 * would be a model reading untrusted text and deciding whether to trust it, which is
 * the exact shape of the problem this is supposed to catch.
 */

/**
 * What the file is. A skill is something the agent wrote for itself; a definition is a
 * persona somebody installed. Both change what an agent will do tomorrow and neither
 * is visible in any client, which is why they are reviewed through one screen.
 */
export const DEFINITION_KIND = {
  SKILL: 'skill',
  AGENT: 'agent',
} as const;

export type DefinitionKind = (typeof DEFINITION_KIND)[keyof typeof DEFINITION_KIND];

/**
 * How much a definition is allowed to touch, as its own file states it.
 *
 * `INHERITS` is the one that matters. A Claude Code subagent with no `tools` key
 * inherits every built-in and MCP tool the session has — shell, writes, and whatever
 * servers are connected — so an absent key is the *widest* grant a file can carry and
 * not the narrowest. Folding it in with `DECLARED: []` would report it as the opposite
 * of what it is, which is why these are three answers and not two.
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
  /**
   * Command-line tools it names, matched against the verb tables. A name in a
   * document is evidence and not proof — this is reported as "it mentions kubectl",
   * never as "it runs kubectl".
   */
  reaches: string[];
  /** Content digest, so a change is detected without keeping the text. */
  digest: string;
}

export interface SkillFinding extends DiscoveredSkill {
  standing: SkillStanding;
  /** What it reaches now and did not before. The whole reason to hold it. */
  gained: string[];
  /**
   * Its own grant got wider — it named fewer tools before, or it named some and now
   * names none at all. A fence that was removed is a widening the text may not show.
   */
  widerGrant: boolean;
}

/**
 * Where each agent keeps them. A layout nobody has published is not guessed at, and
 * OpenClaw is absent for exactly that reason.
 *
 * `nested` is for a product that groups skills under a category directory, so the
 * skill is two levels down rather than one. Hermes does, and it is the agent this
 * whole screen exists for: it writes its own skills between one run and the next.
 */
const SKILL_ROOTS: readonly { agent: string; path: string; nested?: true }[] = [
  { agent: 'claude-code', path: '.claude/skills' },
  { agent: 'codex', path: '.codex/skills' },
  { agent: 'cursor', path: '.cursor/skills' },
  { agent: 'hermes', path: '.hermes/skills', nested: true },
  /* `.agents/skills` is the Codex-mode convention, and anything may write there —
     Ruflo included. It is attributed to Codex because that is whose directory it is;
     saying Ruflo would put a swarm on a machine that has no swarm, which is the
     mistake `.harness` already taught. Ruflo keeps no skills of its own: it writes
     into whichever host it scaffolded, and those are already covered above. */
  { agent: 'codex', path: '.agents/skills' },
];

const SKILL_FILES = ['SKILL.md', 'skill.md', 'index.md'];

/**
 * Where each harness keeps the personas somebody installed into it.
 *
 * Unlike a skill these are flat files, one per definition, and they arrive by the
 * hundred: a public roster is `git clone` and one script away, and the install
 * overwrites what was there without keeping a copy. Nobody reads three hundred files,
 * so nobody notices that most of them declare no tool grant at all.
 *
 * `inherits` says what an absent grant means *on this harness*. It is true only where
 * the vendor documents that a definition with no tool list gets the session's whole
 * tool set. Where that is not documented the answer is `UNREAD`, because reporting a
 * guess as the widest possible grant is how a screen stops being believed.
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
      /* Listed rather than probed for: a directory that lists nothing is absent for
         this purpose, and one fewer round trip on a path most machines do not have. */
      for (const name of childrenOf(await reader.list(dir))) {
        const here = `${dir}/${name}`;
        const text = await readSkill(reader, here);
        if (text !== null) {
          found.push(skillAt(agent, name, here, text, binaries));
          continue;
        }
        if (nested !== true) continue;
        /* A category directory rather than a skill. The skill is named by its own
           directory, not the group it sits in: two products both grouping under
           `web` must not collapse into one row called `web`. */
        for (const child of childrenOf(await reader.list(here))) {
          const inner = `${here}/${child}`;
          const body = await readSkill(reader, inner);
          if (body === null) continue;
          found.push(skillAt(agent, child, inner, body, binaries));
        }
      }
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Personas installed into an agent's own directory, read for the grant they carry.
 *
 * A definition file is prose with a header, and it is easy to file under documentation
 * — the largest public roster's own security policy calls these *"non-executable
 * prompt definitions"*. On a harness that inherits, a file declaring no tools runs
 * with the shell and every connected server, so the header is the grant and the prose
 * is the part that does not matter here.
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
          skillAt(
            agent,
            name.slice(0, -suffix.length),
            here,
            text,
            binaries,
            DEFINITION_KIND.AGENT,
            grantOf(text, suffix, inherits),
          ),
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
 * The tool grant a definition states, read out of its own header.
 *
 * An absent key is only reported as `INHERITS` where the harness documents that
 * meaning; everywhere else it is `UNREAD`, which reads as "this says nothing" rather
 * than as a finding. The difference is the whole point: one of them is the widest
 * grant on the machine and the other is no evidence at all.
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

/**
 * Immediate children, whatever the reader handed back.
 *
 * The port says immediate children and a real `readdir` gives exactly that, but a
 * reader that returns deeper paths must not silently produce a skill called
 * `deploy/SKILL.md`. Taking the first segment is right for both.
 */
function childrenOf(entries: readonly string[]): string[] {
  return [...new Set(entries.map((each) => each.split('/')[0] ?? each))].filter(
    (each) => each !== '',
  );
}

function skillAt(
  agent: string,
  name: string,
  path: string,
  text: string,
  binaries: readonly string[],
  kind: DefinitionKind = DEFINITION_KIND.SKILL,
  grant: ToolGrant = { kind: GRANT.UNREAD, tools: [] },
): DiscoveredSkill {
  return {
    // Keyed on the path, or two skills of the same name under one agent collide.
    id: `skl_${digest(`${agent}:${path}`).slice(0, 12)}`,
    name,
    path,
    agent,
    kind,
    grant,
    reaches: reachOf(text, binaries),
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
 * Binaries the text names, matched whole so `terraform` is a hit and `terraforming`
 * is not. Only tools there is a verb table for: a table is what decides whether a
 * command is destructive, so a name with no table behind it says nothing enforceable.
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
 * What changed since somebody last looked.
 *
 * A new skill is reported and not held: an agent that cannot write its first skill is
 * an agent somebody switches this off to use. A skill that reaches *further* than the
 * accepted version is held, because that is the case nobody would otherwise notice.
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
 * Whether the file's own grant got wider than the one somebody accepted.
 *
 * Losing the key entirely is the case worth catching: a definition that named four
 * tools yesterday and names none today reads as a smaller diff and is the largest
 * possible change, because absent means the whole session's tool set.
 */
export function grantWidened(before: ToolGrant | undefined, now: ToolGrant): boolean {
  // Accepted before grants were read: there is nothing to compare, so nothing is held.
  if (before === undefined) return false;
  if (now.kind === GRANT.INHERITS) return before.kind !== GRANT.INHERITS;
  if (now.kind !== GRANT.DECLARED || before.kind !== GRANT.DECLARED) return false;
  return now.tools.some((each) => !before.tools.includes(each));
}

/**
 * How many definitions arriving together stop being somebody's own work.
 *
 * One definition a person wrote is the case `NEW` is deliberately not held for. A
 * dozen appearing in one directory between two scans is an install, and the roster
 * somebody installed is not one they wrote or read.
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

/**
 * Rosters that arrived at once, as one row each rather than three hundred.
 *
 * Grouped because the finding is the install and not any one file: three hundred rows
 * is a screen nobody reads, and a queue nobody reads holds nothing.
 */
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
 * Held until a person looks.
 *
 * Two cases, and they are not the same worry. A definition that reaches further than
 * the version somebody accepted is the one nobody would otherwise notice. A roster
 * that arrived all at once is one nobody has read at all — which is why `NEW` stays
 * unheld on its own, and stops being on its own at a dozen.
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
  /* Two different claims, kept apart on purpose. A grant is what the file states and a
     name in prose is evidence somebody should look — printing them as one number would
     turn the checkable half into the guessable one. */
  const grant = describeGrant(finding.grant);
  const states = finding.kind === DEFINITION_KIND.AGENT ? `${grant}, ${reach}` : reach;
  if (finding.standing !== SKILL_STANDING.WIDENED) return `${finding.name} — ${states}`;

  // What got wider goes in one clause or the other, and saying it twice reads as noise.
  const wider = finding.widerGrant ? [...finding.gained, grant] : finding.gained;
  return `${finding.name} now also ${wider.join(', ')} — ${finding.widerGrant ? reach : states}`;
}
