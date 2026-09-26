/**
 * `memnox policy`: what the rules say, what will not load, and what one action would do.
 * `test` evaluates against every file in force, so it answers what the seams would answer.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import type { Command } from 'commander';

import {
  DECISION_EFFECT,
  EFFECT_PRECEDENCE,
  EXIT,
  loadPoliciesFromFile,
  loadPolicySet,
  LocalGate,
  MEMNOX_HOME,
  readPolicyRegistry,
  renameEffectsIn,
  resolveShellLine,
  classifyToolCall,
  HTTP_METHOD_ARGUMENT,
  verbForAction,
  verbTableFor,
  POLICY_REGISTRY_FILE,
  targetsRuledOn,
  alternativeFor,
  type ActionRequest,
  type Alternative,
  type LocalVerdict,
  type PolicySet,
} from '@memnox/core';

import type { CliContext } from '../cli-context';
import { TONE, type FlowRow } from '../flow';
import { backupPathFor } from '../memnox-paths';
import {
  policyFilesInForce,
  policySetInForce,
  resolvePolicyFile,
  renderWhatDidNotLoad,
} from '../policy-path';
import { forgetPolicyFiles, registerPolicyFile } from '../policy-registry';

interface TestOptions {
  file?: string;
  agent: string;
  target?: string;
  /** What the action does, for an action named outright whose class nothing here knows. */
  class?: string;
}

interface CheckOptions {
  prune?: boolean;
  fix?: boolean;
}

/** What `policy` reads the machine through, injected so a test never reads the real one. */
interface PolicyDeps {
  home: () => string;
  env: NodeJS.ProcessEnv;
}

/**
 * Classified exactly as a seam would: the whole line through the shell resolver, so a
 * redirect or a second command is ruled on, and each with the class a rule narrows by.
 */
function requestsFor(
  input: string,
  options: TestOptions,
  env: NodeJS.ProcessEnv,
): ActionRequest[] {
  // Already a namespaced action, e.g. from a git hook.
  if (!input.includes(' ') && input.includes('.')) {
    const toolClass = options.class ?? classOfAction(input);
    return [
      {
        action: input,
        ...(options.target === undefined ? {} : { target: options.target }),
        ...(toolClass === undefined ? {} : { toolClass }),
      },
    ];
  }

  const actions = resolveShellLine(input, env).actions;
  if (actions.length === 0) return [{ action: input }];
  return actions.flatMap((resolved) => {
    const common = {
      action: resolved.action,
      toolClass: options.class ?? String(resolved.class),
      ...(resolved.method === undefined
        ? {}
        : { arguments: { [HTTP_METHOD_ARGUMENT]: resolved.method } }),
    };
    if (options.target !== undefined) return [{ ...common, target: options.target }];
    // One per file named, through the shell seam's own helper, so this stays a dry run.
    return targetsRuledOn(resolved).map((target) => ({
      ...common,
      ...(target === undefined ? {} : { target }),
    }));
  });
}

/** The class a seam would send for an action named outright: its verb, or its tool name. */
function classOfAction(action: string): string | undefined {
  const verb = verbForAction(action, verbTableFor);
  if (verb !== null) return verb.class;
  if (action.startsWith('mcp.'))
    return classifyToolCall(action.split('.').pop() ?? '').class;
  return undefined;
}

export function registerPolicyCommand(
  program: Command,
  context: CliContext,
  overrides: Partial<PolicyDeps> = {},
): void {
  const deps: PolicyDeps = { home: homedir, env: process.env, ...overrides };
  const policy = program.command('policy').description('Inspect the rules in force');

  policy
    .command('check [file]')
    .description('Read every rule file on this machine and say what will not load')
    .option('--prune', 'forget registered files that are no longer on the disk')
    .option('--fix', 'rewrite effects this version renamed, keeping a backup')
    .action(async (file: string | undefined, options: CheckOptions) =>
      runCheck(context, deps, file, options),
    );

  policy
    .command('use [file]')
    .description('Register a rule file, so the seams load it and not only "policy test"')
    .action(async (file: string | undefined) => runUse(context, deps, file));

  policy
    .command('test <action>')
    .description('Evaluate one action against the rules, changing nothing')
    .option('-f, --file <path>', 'policy file (default: whichever exists)')
    .option('-a, --agent <name>', 'agent the rules are matched against', 'agent')
    .option('-t, --target <target>', 'what the action operates on')
    .option(
      '-c, --class <class>',
      'what it does: read, write, destructive, communication',
    )
    .action(async (action: string, options: TestOptions) =>
      runTest(context, deps, action, options),
    );
}

/** Reads every rule file and says what will not load, optionally fixing and pruning. */
async function runCheck(
  context: CliContext,
  deps: PolicyDeps,
  file: string | undefined,
  options: CheckOptions,
): Promise<void> {
  context.flow.open('memnox policy check');
  const home = deps.home();
  if (options.fix === true) await fixRenamedEffects(context, home, file);
  await checkPolicyFiles(context, home, file, options.prune === true);
}

/**
 * Puts a rule file in force for every seam. Loaded before it is registered, because a
 * file that will not parse in the set every seam reads ungoverns the machine.
 */
async function runUse(
  context: CliContext,
  deps: PolicyDeps,
  file: string | undefined,
): Promise<void> {
  const { flow } = context;
  const home = deps.home();
  flow.open('memnox policy use');

  const path = resolve(resolvePolicyFile(file));
  if (!existsSync(path)) {
    throw new Error(`No rule file at ${path}. Write one with "memnox protect --yes".`);
  }
  const policies = await loadPoliciesFromFile(path);
  const before = await readPolicyRegistry(join(home, MEMNOX_HOME, POLICY_REGISTRY_FILE));
  await registerPolicyFile(home, path);

  flow.rows('Registered', [
    { label: 'file', value: path },
    { label: 'rules', value: `${policies.length} load at every seam` },
    {
      label: 'was',
      value: before.includes(path) ? 'already registered' : 'not registered here',
    },
  ]);
  flow.close(`${policies.length} rule(s) now load at every seam.`);
  flow.hint('Check it with "memnox doctor --wiring".');
}

/** Evaluates one action against every rule in force, running and changing nothing. */
async function runTest(
  context: CliContext,
  deps: PolicyDeps,
  action: string,
  options: TestOptions,
): Promise<void> {
  const { flow, style } = context;
  flow.open('memnox policy test');

  // Every file in force, so this answers what the seams would rather than what one says.
  const rules = await policySetInForce(deps.home(), options.file);
  if (rules.policies.length === 0 && rules.unreadable.length === 0) {
    throw new Error(
      `No rules at ${resolvePolicyFile(options.file)}. Write some first:  memnox protect --interactive`,
    );
  }
  renderWhatDidNotLoad(context, rules);

  const gate = new LocalGate(rules.policies, { agentName: options.agent });
  // The strictest verdict of every target the action names, since any one of them decides.
  const verdict = requestsFor(action, options, deps.env)
    .map((request) => gate.evaluate(request))
    .reduce((worst, each) =>
      EFFECT_PRECEDENCE[each.effect] > EFFECT_PRECEDENCE[worst.effect] ? each : worst,
    );

  // The verb table's way forward where a rule only said to ask, the same one a seam prints.
  const fromTable = resolveShellLine(action, deps.env).actions.find(
    (each) => each.alternative !== undefined,
  );
  const alternative = alternativeFor(
    verdict.alternative,
    fromTable?.alternative,
    fromTable?.action ?? action,
  );
  flow.rows(action, verdictRows(context, verdict, alternative, fromTable?.action));
  flow.close(style.effect(verdict.effect, `${verdict.effect.toUpperCase()}  ${action}`));
  flow.hint('Nothing was run, and nothing on this machine changed.');
  if (verdict.effect !== DECISION_EFFECT.ALLOW) process.exitCode = EXIT.FAILED;
}

/** The verdict as a card: what was decided, why, by which rule, and what to do instead. */
function verdictRows(
  context: CliContext,
  verdict: LocalVerdict,
  // A refusal that names no way forward is a dead end the agent cannot act on.
  alternative: Alternative | undefined,
  refused: string | undefined,
): FlowRow[] {
  const rule = verdict.matchedPolicies[0];
  return [
    // Upper case, the way `why` renders it, since this is the word pasted into an issue.
    {
      label: 'verdict',
      value: context.style.effect(verdict.effect, verdict.effect.toUpperCase()),
    },
    { label: 'reason', value: verdict.reason },
    ...(rule === undefined ? [] : [{ label: 'rule', value: rule.name }]),
    ...(alternative === undefined
      ? []
      : [
          {
            label: 'instead',
            value: insteadOf(alternative, refused),
          },
        ]),
  ];
}

/** Every rule file this machine would load, checked, with each path in full so a fix can find it. */
async function checkPolicyFiles(
  context: CliContext,
  home: string,
  file: string | undefined,
  prune: boolean,
): Promise<void> {
  const files = file !== undefined ? [file] : await policyFilesInForce(home);
  if (files.length === 0) {
    context.flow.close('No rule files on this machine.');
    context.flow.hint('Write some with "memnox protect".');
    return;
  }

  const set = await loadPolicySet(files);
  // A registered checkout that moved is not a fault to fix, so it is said separately.
  const forgotten =
    set.missing.length > 0 && prune && file === undefined
      ? await forgetPolicyFiles(home, set.missing).then(() => set.missing.length)
      : 0;
  renderRuleFiles(context, set, forgotten > 0);
  renderCheckSummary(context, set, prune);
}

function renderRuleFiles(context: CliContext, set: PolicySet, forgotten: boolean): void {
  context.flow.list('Rule files', [
    ...set.loaded.map((loaded) => ({
      tone: TONE.OK,
      text: `${loaded.file}  ${loaded.rules} rule(s)`,
    })),
    ...set.missing.map((missing) => ({
      tone: TONE.DIM,
      text: `${missing}  gone`,
      detail: [forgotten ? 'forgotten, because --prune was given' : undefined],
    })),
    ...set.unreadable.map((broken) => ({
      tone: TONE.WARN,
      text: `${broken.file}  would not load`,
      detail: broken.issues,
    })),
  ]);
}

function renderCheckSummary(context: CliContext, set: PolicySet, prune: boolean): void {
  const { flow, style } = context;
  flow.close(
    set.unreadable.length === 0
      ? `${set.policies.length} rule(s) in force from ${set.loaded.length} file(s).`
      : style.warn(
          `${set.unreadable.length} file(s) would not load, so ${set.policies.length} rule(s) are in force from ${set.loaded.length}.`,
        ),
  );
  if (set.missing.length > 0 && !prune) {
    flow.hint('Drop the paths that are gone with "memnox policy check --prune".');
  }
  if (set.unreadable.length > 0) {
    flow.hint('Rewrite a renamed effect with "memnox policy check --fix".');
    // Non-zero, so a CI step that checks the rule files fails on a broken one.
    process.exitCode = EXIT.FAILED;
  }
}

/** Rewrites effects an earlier spelling named differently, the one fault this version can fix. */
async function fixRenamedEffects(
  context: CliContext,
  home: string,
  file: string | undefined,
): Promise<void> {
  const files = file !== undefined ? [resolve(file)] : await policyFilesInForce(home);
  let touched = 0;
  for (const path of files) {
    if (await fixOneFile(context, home, path)) touched += 1;
  }
  if (touched === 0) {
    context.flow.step('Nothing to fix', 'no file names a renamed effect');
  }
}

/** Backs the file up, rewrites it, and says so; false when it named nothing renamed. */
async function fixOneFile(
  context: CliContext,
  home: string,
  path: string,
): Promise<boolean> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch {
    // Gone or unreadable: reported by the check that runs straight after this.
    return false;
  }
  const { text, renamed } = renameEffectsIn(source);
  if (renamed.length === 0) return false;

  const backup = backupPathFor(home, path);
  await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
  await writeFile(backup, source, 'utf8');
  await writeFile(path, text, 'utf8');
  context.flow.list('Fixed', [
    {
      tone: TONE.OK,
      text: `${path}  ${renamed.length} effect(s)`,
      detail: [...new Set(renamed), `kept the original at ${backup}`],
    },
  ]);
  return true;
}

/**
 * What to do, in the rule's words, with the action beside it where it names another one.
 * The verb table's way forward is filed under the refused action, which is no help to repeat.
 */
function insteadOf(alternative: Alternative, refused: string | undefined): string {
  if (alternative.action === refused) return alternative.note;
  const action =
    alternative.resource === undefined
      ? alternative.action
      : `${alternative.action} ${alternative.resource}`;
  return alternative.note === alternative.action
    ? action
    : `${alternative.note} (${action})`;
}
