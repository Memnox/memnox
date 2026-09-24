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
import { TONE, type FlowItem } from '../flow';
import { resolvePolicyFile } from '../policy-path';
import { BACKUP_SUFFIX, jsonText } from './json-config';

/**
 * One target per product that publishes a permission format Memnox can write, because a
 * rule compiled into the agent's own config bites even when the agent bypasses us.
 */

/** A product with no published format is not listed, since inventing one writes a file nobody agreed to. */
interface NativeTarget {
  product: string;
  path: string;
  /** YAML is edited a line at a time; JSON is written whole. */
  text?: true;
  /** What the write did, in counts, for the line the reader sees. */
  apply: (raw: string, policies: readonly Policy[]) => NativeWrite;
  revert: (raw: string) => string;
}

interface NativeWrite {
  text: string;
  summary: string;
  untranslated: { policy: string; because: string }[];
  /** Anything true about the merged file the reader would not guess from the counts. */
  notes?: string[];
}

const TARGETS: readonly NativeTarget[] = [
  {
    product: 'Claude Code',
    path: join('.claude', 'settings.json'),
    apply: (raw, policies) => {
      const translation = toClaudeCodePermissions(policies);
      const { allow, ask, deny } = translation.permissions;
      return {
        text: jsonText(applyNative(JSON.parse(raw) as NativeSettings, translation)),
        summary: `${allow.length} allow, ${ask.length} ask and ${deny.length} deny`,
        untranslated: translation.untranslated,
      };
    },
    revert: (raw) => jsonText(revertNative(JSON.parse(raw) as NativeSettings)),
  },
  {
    product: 'OpenClaw',
    path: join('.openclaw', 'openclaw.json'),
    apply: (raw, policies) => {
      const translation = toOpenClawTools(policies);
      const { allow, deny } = translation.tools;
      const settings = JSON.parse(raw) as OpenClawSettings;
      // Their allow list is theirs, so a denied tool stays in it for a revert to leave
      // alone; OpenClaw denies when both name a tool, and the reader is told so.
      const contested = deny.filter((tool) =>
        (settings.tools?.allow ?? []).includes(tool),
      );
      return {
        text: jsonText(applyOpenClaw(settings, translation)),
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
    revert: (raw) => jsonText(revertOpenClaw(JSON.parse(raw) as OpenClawSettings)),
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
    // Only ours: the fence says we wrote the list, and a hand-maintained one has none.
    revert: (raw) =>
      yamlListIsManaged(raw, 'approvals', 'deny')
        ? setYamlList(raw, 'approvals', 'deny', [])
        : raw,
  },
];

interface PresentTarget {
  target: NativeTarget;
  path: string;
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
  const present = presentTargets(home());
  const policies = reverting ? [] : await rulesToWrite();
  const done: FlowItem[] = [];
  let written = 0;
  for (const each of present) {
    const item = await writeTarget(each, reverting, policies);
    done.push(item);
    if (item.tone === TONE.OK) written += 1;
  }
  if (written === 0) {
    throw new Error(
      'Every permission file found was unreadable, so nothing was changed.',
    );
  }
  renderNative(context, { done, written, reverting });
}

function presentTargets(home: string): PresentTarget[] {
  const present = TARGETS.map((target) => ({
    target,
    path: join(home, target.path),
  })).filter((each) => existsSync(each.path));
  if (present.length === 0) {
    throw new Error(
      'No agent here publishes a permission file Memnox can write. Looked for:\n' +
        TARGETS.map((each) => `  ${join(home, each.path)}  (${each.product})`).join('\n'),
    );
  }
  return present;
}

/** One target written or reverted, as the line the reader sees; dim when it was left alone. */
async function writeTarget(
  { target, path }: PresentTarget,
  reverting: boolean,
  policies: readonly Policy[],
): Promise<FlowItem> {
  const raw = await readFile(path, 'utf8');
  // A JSON target is written whole, so one we cannot parse would lose what we did not
  // understand; a text target replaces one block and copies every other byte.
  if (target.text !== true && !isJson(raw)) {
    return {
      tone: TONE.DIM,
      text: `${target.product} was left alone`,
      detail: [
        `${path} is not plain JSON, so ${target.product} is governed at the seams instead`,
      ],
    };
  }
  await writeFile(`${path}${BACKUP_SUFFIX}`, raw, 'utf8');
  if (reverting) {
    await writeFile(path, target.revert(raw), 'utf8');
    return {
      tone: TONE.OK,
      text: `Took our rules back out of ${target.product}`,
      detail: [path],
    };
  }
  const result = target.apply(raw, policies);
  await writeFile(path, result.text, 'utf8');
  return {
    tone: TONE.OK,
    text: `${target.product}: wrote ${result.summary}`,
    detail: [
      path,
      // Anything that could not be written is named, or somebody trusts a rule that is not there.
      ...result.untranslated.map(
        (each) => `not written: ${each.policy}, because ${each.because}`,
      ),
      ...(result.notes ?? []),
    ],
  };
}

function isJson(raw: string): boolean {
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

interface NativeSummary {
  done: readonly FlowItem[];
  written: number;
  reverting: boolean;
}

function renderNative(
  context: CliContext,
  { done, written, reverting }: NativeSummary,
): void {
  const { flow } = context;
  flow.list(reverting ? 'Reverted' : "Written into each agent's own file", done);
  flow.close(
    reverting
      ? `Took our rules back out of ${written} agent(s).`
      : `Wrote our rules into ${written} agent(s).`,
  );
  if (!reverting) flow.hint('Undo with "memnox protect --revert-native".');
}

async function rulesToWrite(): Promise<Policy[]> {
  const rules = resolvePolicyFile();
  if (!existsSync(rules)) {
    throw new Error(`No rules at ${rules} to write. Try "memnox protect --interactive".`);
  }
  return loadPoliciesFromFile(rules);
}
