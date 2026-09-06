import { homedir, userInfo } from 'node:os';
import type { Command } from 'commander';
import {
  describeSkill,
  discoverSkills,
  quarantined,
  readAcceptedSkills,
  reviewSkills,
  SKILL_STANDING,
  writeAcceptedSkills,
  type AcceptedSkill,
  type MachineReader,
  type SkillFinding,
} from '@memnox/core';
import { NodeMachineReader } from '@memnox/core';
import type { CliContext } from '../cli-context';

/**
 * Skills an agent wrote for itself, treated like deployments.
 *
 * The dangerous change is never the obviously wrong skill. It is the one that quietly
 * reaches further than the version somebody accepted — yesterday it edited files,
 * today it also names `kubectl` — because that is the change nobody would look at.
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
    .description('What your agents have taught themselves, and what changed')
    .option('--accept [name]', 'accept one skill as reviewed, or all of them')
    .option('--json', 'machine-readable output')
    .action(async (options: { accept?: boolean | string; json?: boolean }) => {
      const machine = reader();
      const found = await discoverSkills(machine);
      const accepted = await readAcceptedSkills(home());
      const findings = reviewSkills(found, accepted);

      if (options.accept !== undefined && options.accept !== false) {
        const wanted =
          typeof options.accept === 'string'
            ? findings.filter((each) => each.name === options.accept)
            : findings;
        if (wanted.length === 0)
          throw new Error(`No skill called "${String(options.accept)}".`);

        await writeAcceptedSkills(home(), merge(accepted, wanted, now().toISOString()));
        context.out.line(`Accepted ${wanted.length} skill(s).`);
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
      acceptedAt: at,
      acceptedBy: userInfo().username,
    });
  }
  return [...by.values()];
}

function render(context: CliContext, findings: readonly SkillFinding[]): void {
  const { out, style } = context;
  if (findings.length === 0) {
    out.line('No agent skills found on this machine.');
    return;
  }

  const held = quarantined(findings);
  const fresh = findings.filter((each) => each.standing === SKILL_STANDING.NEW);

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
    for (const skill of fresh) out.line(`  ${style.dim('+')}  ${describeSkill(skill)}`);
  }

  const known = findings.length - held.length - fresh.length;
  out.line('');
  out.line(`${findings.length} skill(s); ${known} unchanged since you last looked.`);
  if (held.length > 0 || fresh.length > 0) {
    out.note('"memnox skills --accept <name>" records that you have looked at one.');
  }
  /* A name in a document is evidence, never proof. Saying so is the difference between
     a finding somebody can act on and one they learn to ignore. */
  out.note('A skill naming a tool is evidence it may use it, not proof that it does.');
}
