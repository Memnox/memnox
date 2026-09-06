import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  applyNative,
  applyOpenClaw,
  loadPoliciesFromFile,
  revertNative,
  revertOpenClaw,
  commandGlobFor,
  setYamlList,
  toClaudeCodePermissions,
  toHermesApprovals,
  toOpenClawTools,
  verbTableFor,
  yamlListIsManaged,
  type NativeSettings,
  type OpenClawSettings,
  type Policy,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { resolvePolicyFile } from '../policy-path';

/**
 * One target per product that publishes a permission format Memnox can write. A rule
 * compiled into the agent's own config bites even when the agent is not going through
 * us, which is the whole point; a product with no such format is not listed, because
 * inventing one would be writing a file its author never agreed to.
 */
interface NativeTarget {
  product: string;
  path: string;
  /** YAML is edited a line at a time; JSON is written whole. */
  text?: true;
  /** What the write did, in counts, for the line the reader sees. */
  apply: (
    raw: string,
    policies: readonly Policy[],
  ) => {
    text: string;
    summary: string;
    untranslated: { policy: string; because: string }[];
    /** Anything true about the merged file the reader would not guess from the counts. */
    notes?: string[];
  };
  revert: (raw: string) => string;
}

const TARGETS: readonly NativeTarget[] = [
  {
    product: 'Claude Code',
    path: join('.claude', 'settings.json'),
    apply: (raw, policies) => {
      const translation = toClaudeCodePermissions(policies);
      const { allow, ask, deny } = translation.permissions;
      return {
        text: json(applyNative(JSON.parse(raw) as NativeSettings, translation)),
        summary: `${allow.length} allow, ${ask.length} ask and ${deny.length} deny`,
        untranslated: translation.untranslated,
      };
    },
    revert: (raw) => json(revertNative(JSON.parse(raw) as NativeSettings)),
  },
  {
    product: 'OpenClaw',
    path: join('.openclaw', 'openclaw.json'),
    apply: (raw, policies) => {
      const translation = toOpenClawTools(policies);
      const { allow, deny } = translation.tools;
      const settings = JSON.parse(raw) as OpenClawSettings;
      /* Their allow list is theirs, so a tool we deny is left in it rather than
         edited out — a revert could not put back something we removed. OpenClaw
         resolves the pair by denying, and the reader is told so instead of
         discovering a file that appears to say two things at once. */
      const contested = deny.filter((tool) =>
        (settings.tools?.allow ?? []).includes(tool),
      );
      return {
        text: json(applyOpenClaw(settings, translation)),
        summary: `${allow.length} allowed and ${deny.length} denied tool(s)`,
        untranslated: translation.untranslated,
        notes:
          contested.length === 0
            ? []
            : [
                `${contested.join(', ')} stays in your own allow list and is now denied too; OpenClaw denies when both name a tool.`,
              ],
      };
    },
    revert: (raw) => json(revertOpenClaw(JSON.parse(raw) as OpenClawSettings)),
  },
  {
    product: 'Hermes',
    path: join('.hermes', 'config.yaml'),
    text: true,
    apply: (raw, policies) => {
      const translation = toHermesApprovals(policies, (action) =>
        commandGlobFor(action, verbTableFor),
      );
      return {
        text: setYamlList(raw, 'approvals', 'deny', translation.deny),
        summary: `${translation.deny.length} command pattern(s) into approvals.deny`,
        untranslated: translation.untranslated,
        notes:
          translation.deny.length === 0
            ? []
            : [
                'approvals.deny blocks before any yolo bypass, which is why a deny goes there.',
              ],
      };
    },
    /* Only ours: the fence says we wrote the list, and a hand-maintained one has none. */
    revert: (raw) =>
      yamlListIsManaged(raw, 'approvals', 'deny')
        ? setYamlList(raw, 'approvals', 'deny', [])
        : raw,
  },
];

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * The same rules in each agent's own format, so they still bite when the agent is not
 * going through us. Backed up first: these are somebody's editor and agent settings.
 */
export async function runNative(
  context: CliContext,
  reverting: boolean,
  home: () => string = homedir,
): Promise<void> {
  const present = TARGETS.map((target) => ({
    target,
    path: join(home(), target.path),
  })).filter((each) => existsSync(each.path));

  if (present.length === 0) {
    throw new Error(
      'No agent here publishes a permission file Memnox can write. Looked for:\n' +
        TARGETS.map((each) => `  ${join(home(), each.path)}  (${each.product})`).join(
          '\n',
        ),
    );
  }

  const policies = reverting ? [] : await rulesToWrite();
  let written = 0;

  for (const { target, path } of present) {
    const raw = await readFile(path, 'utf8');
    /* A JSON target is written whole, so a file we cannot parse would come back
       without whatever we failed to understand. A text target replaces one block and
       copies every other byte, so it has nothing to lose and needs no guard. */
    if (target.text !== true) {
      try {
        JSON.parse(raw);
      } catch {
        context.out.note(
          `${path} is not plain JSON, so it was left alone — ${target.product} is governed at the seams instead.`,
        );
        continue;
      }
    }
    await writeFile(`${path}.memnox-backup`, raw, 'utf8');

    if (reverting) {
      await writeFile(path, target.revert(raw), 'utf8');
      context.out.line(`Took our rules back out of ${target.product}.`);
      written += 1;
      continue;
    }

    const result = target.apply(raw, policies);
    await writeFile(path, result.text, 'utf8');
    context.out.line(`${target.product}: wrote ${result.summary} into ${path}.`);
    // Anything that could not be written is named, or somebody trusts a rule that is not there.
    for (const each of result.untranslated) {
      context.out.note(`  not written: ${each.policy} — ${each.because}`);
    }
    for (const note of result.notes ?? []) context.out.note(`  ${note}`);
    written += 1;
  }

  if (written === 0) {
    throw new Error(
      'Every permission file found was unreadable, so nothing was changed.',
    );
  }
  if (!reverting) context.out.note('Undo with "memnox protect --revert-native".');
}

async function rulesToWrite(): Promise<Policy[]> {
  const rules = resolvePolicyFile();
  if (!existsSync(rules)) {
    throw new Error(`No rules at ${rules} to write. Try "memnox protect --interactive".`);
  }
  return loadPoliciesFromFile(rules);
}
