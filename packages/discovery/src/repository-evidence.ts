import { join } from 'node:path';
import type { MachineReader } from './ports';
import {
  CONTROL_KIND,
  EVIDENCE_SOURCE,
  NORMATIVE_MARKERS,
  REVIEW_MARKERS,
  type ControlKind,
  type EvidenceSource,
} from './discovery.constants';

/**
 * A sentence somebody wrote down, carrying its excerpt, its file and its line.
 *
 * It is evidence and never a policy. A rule can match on it; it permits nothing by
 * itself, because the moment text an agent can reach is able to permit an action,
 * every document in the repository becomes a way to write policy.
 */
export interface StatedRule {
  id: string;
  /** Verbatim. A paraphrase is a claim about what somebody meant. */
  text: string;
  source: EvidenceSource;
  /** The file that proved it, and the line, so the reader can go and argue with it. */
  statedIn: string;
  line: number;
}

/** Something on this disk that actually makes a rule bite, rather than describing it. */
export interface EnforcedControl {
  kind: ControlKind;
  /** The file that carries it. */
  statedIn: string;
  /** What it covers, in the words of the file: an owner line, a hook name. */
  detail: string;
}

export interface RepositoryEvidence {
  root: string;
  stated: StatedRule[];
  enforced: EnforcedControl[];
  /** Everything opened, so the tool that reads a team's documents is itself readable. */
  read: string[];
}

/** Files a repository states its rules in, in the order a reader would look. */
const AGENT_INSTRUCTION_FILES: readonly string[] = ['AGENTS.md', 'CLAUDE.md'];
const POLICY_FILES: readonly string[] = ['SECURITY.md', 'CONTRIBUTING.md'];
const DECISION_DIRS: readonly string[] = [
  'docs/adr',
  'docs/decisions',
  'adr',
  'decisions',
];
const CODEOWNERS_PATHS: readonly string[] = [
  'CODEOWNERS',
  '.github/CODEOWNERS',
  'docs/CODEOWNERS',
];
const HOOK_DIR = '.git/hooks';
/** Git ships these as samples; a sample enforces nothing. */
const HOOK_SAMPLE_SUFFIX = '.sample';
const ENFORCING_HOOKS: readonly string[] = ['pre-commit', 'pre-push', 'commit-msg'];
const MARKDOWN_SUFFIX = '.md';

/**
 * What this repository already says about itself and what it already enforces, read
 * off the disk with no account and no network. Level two evidence needs no forge and
 * no login, which is the whole reason it comes before Slack.
 */
export async function readRepositoryEvidence(
  reader: MachineReader,
  root: string,
): Promise<RepositoryEvidence> {
  const stated: StatedRule[] = [];
  const enforced: EnforcedControl[] = [];
  const read: string[] = [];

  for (const name of AGENT_INSTRUCTION_FILES) {
    stated.push(
      ...(await statedIn(reader, root, name, EVIDENCE_SOURCE.AGENT_INSTRUCTIONS, read)),
    );
  }
  for (const name of POLICY_FILES) {
    stated.push(...(await statedIn(reader, root, name, EVIDENCE_SOURCE.POLICY, read)));
  }
  for (const dir of DECISION_DIRS) {
    for (const name of await reader.list(join(root, dir))) {
      if (!name.endsWith(MARKDOWN_SUFFIX)) continue;
      stated.push(
        ...(await statedIn(
          reader,
          root,
          join(dir, name),
          EVIDENCE_SOURCE.DECISION,
          read,
        )),
      );
    }
  }

  for (const path of CODEOWNERS_PATHS) {
    const owners = await ownersIn(reader, root, path, read);
    enforced.push(...owners);
  }
  enforced.push(...(await hooksIn(reader, root)));

  return { root, stated, enforced, read };
}

/**
 * The normative sentences in one file. A line is a rule when it carries a modal a
 * person chose deliberately — must, never, always, do not — and nothing else is
 * promoted, because a prose summary is not something a rule can match on.
 */
async function statedIn(
  reader: MachineReader,
  root: string,
  relative: string,
  source: EvidenceSource,
  read: string[],
): Promise<StatedRule[]> {
  const path = join(root, relative);
  const contents = await reader.read(path);
  if (contents === null) return [];
  read.push(path);

  const rules: StatedRule[] = [];
  const lines = contents.split('\n');
  let inCode = false;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw === undefined) continue;
    const text = raw.trim();
    if (text.startsWith(CODE_FENCE)) {
      inCode = !inCode;
      continue;
    }
    if (inCode || text === '') continue;
    // A table row is a reference and a heading is a label. Neither is a sentence
    // somebody wrote to be followed, and promoting them buries the ones that are.
    if (text.startsWith(TABLE_ROW) || text.startsWith(HEADING)) continue;
    if (!isNormative(text)) continue;
    rules.push({
      id: `sr_${relative.replace(/[^a-zA-Z0-9]/g, '_')}_${index + 1}`,
      text: stripMarkup(text),
      source,
      statedIn: relative,
      line: index + 1,
    });
  }
  return rules;
}

const CODE_FENCE = '```';
const TABLE_ROW = '|';
const HEADING = '#';

/** Whole words only: "must" is a modal, "mustard" is a word that contains one. */
function isNormative(text: string): boolean {
  const lowered = text.toLowerCase();
  return NORMATIVE_MARKERS.some((marker) =>
    new RegExp(`\\b${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lowered),
  );
}

/** Headings, list bullets and emphasis are formatting, not part of what was stated. */
function stripMarkup(text: string): string {
  return text
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim();
}

async function ownersIn(
  reader: MachineReader,
  root: string,
  relative: string,
  read: string[],
): Promise<EnforcedControl[]> {
  const path = join(root, relative);
  const contents = await reader.read(path);
  if (contents === null) return [];
  read.push(path);

  const controls: EnforcedControl[] = [];
  for (const raw of contents.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    controls.push({
      kind: CONTROL_KIND.CODE_OWNERS,
      statedIn: relative,
      detail: line,
    });
  }
  return controls;
}

async function hooksIn(reader: MachineReader, root: string): Promise<EnforcedControl[]> {
  const controls: EnforcedControl[] = [];
  for (const name of await reader.list(join(root, HOOK_DIR))) {
    if (name.endsWith(HOOK_SAMPLE_SUFFIX)) continue;
    if (!ENFORCING_HOOKS.includes(name)) continue;
    controls.push({
      kind: CONTROL_KIND.GIT_HOOK,
      statedIn: join(HOOK_DIR, name),
      detail: `${name} runs before the commit lands`,
    });
  }
  return controls;
}

/**
 * A requirement written down with nothing on this disk enforcing it. Both halves are
 * read and the distance between them is the finding, which is the thing nobody
 * currently owns.
 */
export interface PolicyGap {
  /** The sentence that required it, verbatim, with where it was written. */
  documented: StatedRule;
  /** What was found enforcing it here. Empty is the finding. */
  enforcedBy: EnforcedControl[];
  /**
   * What could not be read from a disk. Branch protection lives in the forge, so a
   * gap reported here is a gap in what this machine can see, stated as such.
   */
  unread: string;
}

/** Branch rules are not on this disk, and a report that implied otherwise would lie. */
const UNREAD_BY_THE_OPEN_HALF =
  'branch protection and required reviews live in the forge, not on this disk';

/**
 * Where the document requires a review or an approval and nothing here enforces one.
 * Only review requirements, because those are the ones an on-disk control can answer;
 * a requirement about anything else would be compared against nothing.
 */
export function findPolicyGaps(evidence: RepositoryEvidence): PolicyGap[] {
  const reviewRules = evidence.stated.filter((rule) =>
    REVIEW_MARKERS.some((marker) => rule.text.toLowerCase().includes(marker)),
  );
  return reviewRules.map((documented) => ({
    documented,
    enforcedBy: evidence.enforced.filter(
      (control) => control.kind === CONTROL_KIND.CODE_OWNERS,
    ),
    unread: UNREAD_BY_THE_OPEN_HALF,
  }));
}
