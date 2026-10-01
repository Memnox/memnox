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
  NATIVE_MARKER,
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
  /** The lists a JSON target must hold as strings, since a hand edited file is untrusted. */
  lists?: ListShape;
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

/** Each object key mapped to the list fields inside it that must be strings when present. */
type ListShape = Readonly<Record<string, readonly string[]>>;

const CLAUDE_LISTS: ListShape = {
  permissions: ['allow', 'ask', 'deny'],
  [NATIVE_MARKER]: ['allow', 'ask', 'deny'],
};

const OPENCLAW_LISTS: ListShape = {
  tools: ['allow', 'deny'],
  [NATIVE_MARKER]: ['allow', 'deny'],
};

const TARGETS: readonly NativeTarget[] = [
  {
    product: 'Claude Code',
    path: join('.claude', 'settings.json'),
    lists: CLAUDE_LISTS,
    apply: (raw, policies) => {
      const translation = toClaudeCodePermissions(policies);
      const { allow, ask, deny } = translation.permissions;
      return {
        text: jsonText(
          applyNative(shaped<NativeSettings>(raw, CLAUDE_LISTS), translation),
        ),
        summary: `${allow.length} allow, ${ask.length} ask and ${deny.length} deny`,
        untranslated: translation.untranslated,
      };
    },
    revert: (raw) => jsonText(revertNative(shaped<NativeSettings>(raw, CLAUDE_LISTS))),
  },
  {
    product: 'OpenClaw',
    path: join('.openclaw', 'openclaw.json'),
    lists: OPENCLAW_LISTS,
    apply: (raw, policies) => {
      const translation = toOpenClawTools(policies);
      const { allow, deny } = translation.tools;
      const settings = shaped<OpenClawSettings>(raw, OPENCLAW_LISTS);
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
    revert: (raw) =>
      jsonText(revertOpenClaw(shaped<OpenClawSettings>(raw, OPENCLAW_LISTS))),
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
    // The reasons go in the refusal, because a throw never reaches the list that names them.
    throw new Error(
      [
        'Every permission file found was unreadable, so nothing was changed.',
        ...done
          .flatMap((item) => item.detail ?? [])
          .filter((line): line is string => line !== undefined && line !== '')
          .map((line) => `  ${line}`),
      ].join('\n'),
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
  const problem =
    target.lists === undefined ? undefined : shapeProblem(JSON.parse(raw), target.lists);
  if (problem !== undefined) {
    return {
      tone: TONE.DIM,
      text: `${target.product} was left alone`,
      detail: [`${path} ${problem}, so it was not changed`],
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What is wrong with a parsed settings file, in words for the reader, or undefined when it fits. */
function shapeProblem(value: unknown, lists: ListShape): string | undefined {
  if (!isRecord(value)) return 'does not hold a JSON object';
  for (const [key, fields] of Object.entries(lists)) {
    const section = value[key];
    if (section === undefined) continue;
    if (!isRecord(section)) return `has a "${key}" that is not an object`;
    for (const field of fields) {
      const list = section[field];
      if (list === undefined) continue;
      if (!Array.isArray(list) || !list.every((each) => typeof each === 'string')) {
        return `has a "${key}.${field}" that is not a list of strings`;
      }
    }
  }
  return undefined;
}

function shaped<T>(raw: string, lists: ListShape): T {
  const parsed: unknown = JSON.parse(raw);
  const problem = shapeProblem(parsed, lists);
  if (problem !== undefined) throw new Error(`The settings file ${problem}.`);
  // Every list the core functions read was checked as strings on the line above.
  return parsed as T;
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
