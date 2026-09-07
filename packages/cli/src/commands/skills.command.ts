import { homedir, userInfo } from 'node:os';
import type { Command } from 'commander';
import {
  bulkArrivals,
  DEFINITION_KIND,
  describeGrant,
  describeSkill,
  discoverDefinitions,
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
import { NodeMachineReader } from '@memnox/core';
import type { CliContext } from '../cli-context';

/**
 * What an agent runs on that nobody wrote in a config: skills it taught itself, and
 * personas somebody installed into it. Both are treated like deployments.
 *
 * Two dangerous changes, and they are not the same one. A skill that quietly reaches
 * further than the version somebody accepted is the change nobody would look at. A
 * roster of definitions that arrived together is a change nobody has read at all —
 * and on a harness where an absent tool list means every tool in the session, most of
 * a public roster grants more than anything in the machine's rule files does.
 */
export function registerSkillsCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
  now: () => Date = () => new Date(),
  reader: () => MachineReader = () => new NodeMachineReader(),
): void {
  program
    .command('skills')
    .description('What your agents run on beyond their config, and what changed')
    .option('--accept [name]', 'accept one definition as reviewed, or all of them')
    .option('--json', 'machine-readable output')
    .action(async (options: { accept?: boolean | string; json?: boolean }) => {
      const machine = reader();
      const found = await discoverDefinitions(machine);
      const accepted = await readAcceptedSkills(home());
      const findings = reviewSkills(found, accepted);

      if (options.accept !== undefined && options.accept !== false) {
        const wanted =
          typeof options.accept === 'string'
            ? findings.filter((each) => each.name === options.accept)
            : findings;
        if (wanted.length === 0)
          throw new Error(`Nothing called "${String(options.accept)}".`);

        await writeAcceptedSkills(home(), merge(accepted, wanted, now().toISOString()));
        context.out.line(`Accepted ${wanted.length} definition(s).`);
        return;
      }

      if (options.json === true) {
        context.out.json(findings);
        return;
      }
      render(context, findings);
    });
}

function merge(
  accepted: readonly AcceptedSkill[],
  wanted: readonly SkillFinding[],
  at: string,
): AcceptedSkill[] {
  const by = new Map(accepted.map((each) => [each.id, each]));
  for (const skill of wanted) {
    by.set(skill.id, {
      id: skill.id,
      digest: skill.digest,
      reaches: skill.reaches,
      /* Recorded so a fence that is later removed is a widening. Without it, a
         definition that named four tools and now names none reads as a small edit. */
      grant: skill.grant,
      acceptedAt: at,
      acceptedBy: userInfo().username,
    });
  }
  return [...by.values()];
}

/** What fits a terminal beside the held ones and the closing count. */
const NEW_SHOWN = 12;
/** Enough of a roster to recognise it, and never enough to scroll. */
const ARRIVAL_SHOWN = 4;

function render(context: CliContext, findings: readonly SkillFinding[]): void {
  const { out, style } = context;
  if (findings.length === 0) {
    out.line('No agent skills or definitions found on this machine.');
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

  if (held.length > 0) {
    out.line('');
    out.line(style.bold('HELD') + style.dim('  reaches further than what you accepted'));
    out.line('');
    for (const skill of held) {
      out.line(`  ${style.warn('!')}  ${describeSkill(skill)}`);
      out.line(`     ${style.dim(skill.path)}`);
    }
  }

  if (fresh.length > 0) {
    out.line('');
    out.line(style.bold('NEW'));
    out.line('');
    /* The ones that name a tool first, and the rest counted. Seventy rows is not a
       screen anybody reads, and the sixty that name nothing this knows are the sixty
       there is nothing to decide about. */
    const ordered = [...fresh].sort((a, b) => b.reaches.length - a.reaches.length);
    for (const skill of ordered.slice(0, NEW_SHOWN)) {
      out.line(`  ${style.dim('+')}  ${describeSkill(skill)}`);
    }
    const rest = ordered.length - NEW_SHOWN;
    if (rest > 0) {
      const quiet = ordered.slice(NEW_SHOWN).filter((each) => each.reaches.length === 0);
      out.line(
        `  ${style.dim(`… and ${rest} more, ${quiet.length} of which name no tool this knows`)}`,
      );
      out.note('"memnox skills --json" lists every one.');
    }
  }

  const heldCount = held.length + arrived.size;
  const known = findings.length - heldCount - fresh.length;
  const agents = findings.filter((each) => each.kind === DEFINITION_KIND.AGENT).length;
  out.line('');
  out.line(
    `${findings.length} definition(s), ${agents} installed rather than self-written; ` +
      `${known} unchanged since you last looked.`,
  );
  if (heldCount > 0 || fresh.length > 0) {
    out.note('"memnox skills --accept <name>" records that you have looked at one.');
  }
  /* A name in a document is evidence, never proof. Saying so is the difference between
     a finding somebody can act on and one they learn to ignore. A grant is not in that
     category: the file states it, so it is said as a fact and kept on its own line. */
  out.note('A skill naming a tool is evidence it may use it, not proof that it does.');
}

/**
 * A roster, as one row. The count and how many of them inherit is the finding; the
 * names are four examples, because nobody decides anything from the other three hundred.
 */
function renderArrival(context: CliContext, arrival: Arrival): void {
  const { out, style } = context;
  const total = arrival.definitions.length;
  out.line('');
  out.line(
    style.bold('HELD') + style.dim('  a roster arrived at once, and nobody read it'),
  );
  out.line('');
  out.line(
    `  ${style.warn('!')}  ${total} new ${arrival.agent} definitions in one directory`,
  );
  out.line(`     ${style.dim(arrival.root)}`);
  if (arrival.inheriting > 0) {
    out.line(
      `     ${style.warn(`${arrival.inheriting} of them declare no tools, so each inherits every tool in the session`)}`,
    );
  }
  const named = [...arrival.definitions]
    .sort((a, b) => b.reaches.length - a.reaches.length)
    .slice(0, ARRIVAL_SHOWN);
  for (const one of named) {
    out.line(`     ${style.dim(`${one.name} — ${describeGrant(one.grant)}`)}`);
  }
  if (total > ARRIVAL_SHOWN) {
    out.line(`     ${style.dim(`… and ${total - ARRIVAL_SHOWN} more`)}`);
  }
  out.note(`"memnox skills --accept" records that you have looked at all ${total}.`);
}
