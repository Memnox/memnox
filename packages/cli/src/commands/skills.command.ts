/**
 * `memnox skills`: what an agent runs on that nobody wrote in a config, skills it taught
 * itself and personas somebody installed, both treated like deployments.
 */

import { homedir, userInfo } from 'node:os';
import type { Command } from 'commander';
import {
  bulkArrivals,
  DEFINITION_KIND,
  describeGrant,
  describeSkill,
  discoverDefinitions,
  NodeMachineReader,
  quarantined,
  readAcceptedSkills,
  reviewSkills,
  SKILL_STANDING,
  writeAcceptedSkills,
  type AcceptedSkill,
  type Arrival,
  type MachineReader,
  type SkillFinding,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { TONE } from '../flow';

/** What fits a terminal beside the held ones and the closing count. */
const NEW_SHOWN = 12;
/** Enough of a roster to recognise it, and never enough to scroll. */
const ARRIVAL_SHOWN = 4;

interface SkillsDeps {
  home: () => string;
  now: () => Date;
  reader: () => MachineReader;
  // Who is accepting, recorded beside each definition they accept.
  who: () => string;
}

/** A skill reaching further than the accepted version, or a roster nobody read, is held. */
export function registerSkillsCommand(
  program: Command,
  context: CliContext,
  overrides: Partial<SkillsDeps> = {},
): void {
  const deps: SkillsDeps = {
    home: homedir,
    now: () => new Date(),
    reader: () => new NodeMachineReader(),
    who: () => userInfo().username,
    ...overrides,
  };
  program
    .command('skills')
    .description('What your agents run on beyond their config, and what changed')
    .option('--accept [name]', 'accept one definition as reviewed, or all of them')
    .option('--json', 'machine-readable output')
    .action(async (options: SkillsOptions) => runSkills(context, deps, options));
}

interface SkillsOptions {
  accept?: boolean | string;
  json?: boolean;
}

/** What the agents here run on beyond their config, against what anybody accepted. */
async function runSkills(
  context: CliContext,
  deps: SkillsDeps,
  options: SkillsOptions,
): Promise<void> {
  if (options.json !== true) context.flow.open('memnox skills');
  const home = deps.home();
  const found = await discoverDefinitions(deps.reader());
  const accepted = await readAcceptedSkills(home);
  const findings = reviewSkills(found, accepted);
  if (options.accept !== undefined && options.accept !== false) {
    await runAccept(context, deps, { home, accepted, findings, accept: options.accept });
    return;
  }
  if (options.json === true) {
    context.out.json(findings);
    return;
  }
  renderSkills(context, findings);
}

interface AcceptInput {
  home: string;
  accepted: readonly AcceptedSkill[];
  findings: readonly SkillFinding[];
  accept: true | string;
}

async function runAccept(
  context: CliContext,
  deps: SkillsDeps,
  { home, accepted, findings, accept }: AcceptInput,
): Promise<void> {
  const wanted =
    typeof accept === 'string'
      ? findings.filter((each) => each.name === accept)
      : findings;
  if (wanted.length === 0) throw new Error(`Nothing called "${String(accept)}".`);
  const by = deps.who();
  const at = deps.now().toISOString();
  await writeAcceptedSkills(home, mergeAccepted(accepted, wanted, { at, by }));
  context.flow.close(`Accepted ${wanted.length} definition(s) as reviewed by ${by}.`);
}

function mergeAccepted(
  accepted: readonly AcceptedSkill[],
  wanted: readonly SkillFinding[],
  stamp: { at: string; by: string },
): AcceptedSkill[] {
  const byId = new Map(accepted.map((each) => [each.id, each]));
  for (const skill of wanted) {
    byId.set(skill.id, {
      id: skill.id,
      digest: skill.digest,
      reaches: skill.reaches,
      // Recorded so a fence that is later removed reads as a widening, not a small edit.
      grant: skill.grant,
      acceptedAt: stamp.at,
      acceptedBy: stamp.by,
    });
  }
  return [...byId.values()];
}

function renderSkills(context: CliContext, findings: readonly SkillFinding[]): void {
  if (findings.length === 0) {
    context.flow.close('No agent skills or definitions found on this machine.');
    return;
  }
  const arrivals = bulkArrivals(findings);
  const arrived = new Set(
    arrivals.flatMap((each) => each.definitions.map((one) => one.id)),
  );
  const held = quarantined(findings).filter((each) => !arrived.has(each.id));
  const fresh = findings.filter(
    (each) => each.standing === SKILL_STANDING.NEW && !arrived.has(each.id),
  );
  for (const arrival of arrivals) renderArrival(context, arrival);
  renderHeld(context, held);
  renderFresh(context, fresh);
  renderSkillsSummary(context, findings, {
    held: held.length + arrived.size,
    fresh: fresh.length,
  });
}

function renderHeld(context: CliContext, held: readonly SkillFinding[]): void {
  if (held.length === 0) return;
  context.flow.list(
    'Held: reaches further than what you accepted',
    held.map((skill) => ({
      tone: TONE.WARN,
      text: describeSkill(skill),
      detail: [skill.path],
    })),
  );
}

/** The ones that name a tool first and the rest counted, because seventy rows is not a screen. */
function renderFresh(context: CliContext, fresh: readonly SkillFinding[]): void {
  if (fresh.length === 0) return;
  const ordered = [...fresh].sort((a, b) => b.reaches.length - a.reaches.length);
  const rest = ordered.length - NEW_SHOWN;
  const quiet = ordered.slice(NEW_SHOWN).filter((each) => each.reaches.length === 0);
  const shown = ordered.slice(0, NEW_SHOWN).map((skill) => ({
    tone: TONE.DIM,
    text: describeSkill(skill),
  }));
  if (rest <= 0) {
    context.flow.list('New', shown);
    return;
  }
  context.flow.list('New', [
    ...shown,
    {
      tone: TONE.DIM,
      text: `… and ${rest} more, ${quiet.length} of which name no tool this knows`,
      detail: ['"memnox skills --json" lists every one'],
    },
  ]);
}

function renderSkillsSummary(
  context: CliContext,
  findings: readonly SkillFinding[],
  counted: { held: number; fresh: number },
): void {
  const { flow, style } = context;
  const known = findings.length - counted.held - counted.fresh;
  const agents = findings.filter((each) => each.kind === DEFINITION_KIND.AGENT).length;
  flow.close(
    counted.held === 0
      ? `${findings.length} definition(s), ${agents} installed rather than self-written; ${known} unchanged since you last looked.`
      : style.warn(
          `${counted.held} of ${findings.length} definition(s) are held; ${known} unchanged since you last looked.`,
        ),
  );
  if (counted.held > 0 || counted.fresh > 0) {
    flow.hint('"memnox skills --accept <name>" records that you have looked at one.');
  }
  // A name in a document is evidence, never proof, so it is said as one.
  flow.hint('A skill naming a tool is evidence it may use it, not proof that it does.');
}

/** A roster, as one row: the count and how many inherit is the finding, the names are examples. */
function renderArrival(context: CliContext, arrival: Arrival): void {
  const { flow } = context;
  const total = arrival.definitions.length;
  const named = [...arrival.definitions]
    .sort((a, b) => b.reaches.length - a.reaches.length)
    .slice(0, ARRIVAL_SHOWN);

  flow.list('Held: a roster arrived at once, and nobody read it', [
    {
      tone: TONE.WARN,
      text: `${total} new ${arrival.agent} definitions in one directory`,
      detail: [
        arrival.root,
        arrival.inheriting > 0
          ? `${arrival.inheriting} of them declare no tools, so each inherits every tool in the session`
          : undefined,
        ...named.map((one) => `${one.name}: ${describeGrant(one.grant)}`),
        total > ARRIVAL_SHOWN ? `… and ${total - ARRIVAL_SHOWN} more` : undefined,
      ],
    },
  ]);
  flow.aside(
    context.style.dim(
      `"memnox skills --accept" records that you have looked at all ${total}.`,
    ),
  );
}
