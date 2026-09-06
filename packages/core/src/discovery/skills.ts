import { digest } from '../domain/digest';
import { verbTableNames } from '../verbs/tables';
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
): DiscoveredSkill {
  return {
    // Keyed on the path, or two skills of the same name under one agent collide.
    id: `skl_${digest(`${agent}:${path}`).slice(0, 12)}`,
    name,
    path,
    agent,
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
      return { ...skill, standing: SKILL_STANDING.NEW, gained: skill.reaches };
    }
    if (before.digest === skill.digest) {
      return { ...skill, standing: SKILL_STANDING.KNOWN, gained: [] };
    }
    const gained = skill.reaches.filter((each) => !before.reaches.includes(each));
    return {
      ...skill,
      standing: gained.length > 0 ? SKILL_STANDING.WIDENED : SKILL_STANDING.CHANGED,
      gained,
    };
  });
}

/** Held until a person looks: the ones that reach further than what was accepted. */
export function quarantined(findings: readonly SkillFinding[]): SkillFinding[] {
  return findings.filter((each) => each.standing === SKILL_STANDING.WIDENED);
}

export function describeSkill(finding: SkillFinding): string {
  const reach =
    finding.reaches.length === 0
      ? 'names no tool this knows'
      : `names ${finding.reaches.join(', ')}`;
  if (finding.standing === SKILL_STANDING.WIDENED) {
    return `${finding.name} now also ${finding.gained.join(', ')} — ${reach}`;
  }
  return `${finding.name} — ${reach}`;
}
