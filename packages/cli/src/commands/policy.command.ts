import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import {
  DECISION_EFFECT,
  loadPoliciesFromFile,
  loadPolicySet,
  LocalGate,
  MEMNOX_HOME,
  readPolicyRegistry,
  renameEffectsIn,
  resolveAction,
  targetsRuledOn,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { TONE } from '../flow';
import { backupPathFor } from '../memnox-paths';
import {
  policyFilesInForce,
  policySetInForce,
  resolvePolicyFile,
  sayWhatDidNotLoad,
} from '../policy-path';
import { forgetPolicyFiles, registerPolicyFile } from '../policy-registry';

const REGISTRY_FILE = 'policies.json';

interface TestOptions {
  file?: string;
  agent: string;
  target?: string;
}

/** Quotes kept together, order preserved: this is argv as the kernel would hand it over. */
function splitCommand(input: string): string[] {
  return (input.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((word) =>
    word.replace(/^["']|["']$/g, ''),
  );
}

/**
 * A command line is classified exactly as an interceptor would classify it, or a rule
 * about `git.push` would not match somebody typing `git push --force` — which is the
 * only form anybody actually tests with.
 */
function requestsFor(
  input: string,
  options: TestOptions,
): Parameters<LocalGate['evaluate']>[0][] {
  // Already a namespaced action, e.g. from a git hook.
  if (!input.includes(' ') && input.includes('.')) {
    return [
      {
        action: input,
        ...(options.target === undefined ? {} : { target: options.target }),
      },
    ];
  }

  /* Split in order. `normalizeShellCommand` sorts flags ahead of positionals, which
     is right for spotting a destructive pattern in a shell string and wrong here: argv
     order is what a verb pattern matches against. */
  const argv = splitCommand(input);
  const binary = argv[0] ?? input;
  const resolved = resolveAction(binary, argv.slice(1), process.env);

  if (options.target !== undefined) {
    return [{ action: resolved.action, target: options.target }];
  }
  /* One per file the command names, through the same helper the shell seam uses. What
     this command prints has to be what the seam will do, or `policy test` becomes a
     second opinion rather than a dry run. */
  return targetsRuledOn(resolved).map((target) => ({
    action: resolved.action,
    ...(target === undefined ? {} : { target }),
  }));
}

/** Deny beats ask beats allow, so a line is ruled by its worst file and not its last. */
const SEVERITY: Record<string, number> = {
  [DECISION_EFFECT.ALLOW]: 0,
  [DECISION_EFFECT.ASK]: 1,
  [DECISION_EFFECT.DENY]: 2,
};

export function registerPolicyCommand(program: Command, context: CliContext): void {
  const policy = program.command('policy').description('Inspect the rules in force');

  policy
    .command('check [file]')
    .description('Read every rule file on this machine and say what will not load')
    .option('--prune', 'forget registered files that are no longer on the disk')
    .option('--fix', 'rewrite effects this version renamed, keeping a backup')
    .action(
      async (file: string | undefined, options: { prune?: boolean; fix?: boolean }) => {
        context.flow.open('memnox policy check');
        if (options.fix === true) await fixRenamedEffects(context, file);
        await checkPolicyFiles(context, file, options.prune === true);
      },
    );

  policy
    .command('use [file]')
    .description('Register a rule file, so the seams load it and not only "policy test"')
    .action(async (file: string | undefined) => {
      const { flow } = context;
      flow.open('memnox policy use');
      const path = resolve(resolvePolicyFile(file));
      if (!existsSync(path)) {
        throw new Error(
          `No rule file at ${path}. Write one with "memnox protect --yes".`,
        );
      }
      // Loaded before it is registered: a file that will not parse must never be
      // added to the set every seam reads, or one bad edit ungoverns the machine.
      const policies = await loadPoliciesFromFile(path);
      const before = await readPolicyRegistry(
        join(homedir(), MEMNOX_HOME, REGISTRY_FILE),
      );
      await registerPolicyFile(homedir(), path);
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
    });

  policy
    .command('test <action>')
    .description('Evaluate one action against the rules, changing nothing')
    .option('-f, --file <path>', 'policy file (default: whichever exists)')
    .option('-a, --agent <name>', 'agent the rules are matched against', 'agent')
    .option('-t, --target <target>', 'what the action operates on')
    .action(async (action: string, options: TestOptions) => {
      const { flow, style } = context;
      flow.open('memnox policy test');
      // Every file in force, so this answers what the seams would, not what one file says.
      const rules = await policySetInForce(homedir(), options.file);
      if (rules.policies.length === 0 && rules.unreadable.length === 0) {
        throw new Error(
          `No rules at ${resolvePolicyFile(options.file)}. Write some first:  memnox protect --interactive`,
        );
      }
      sayWhatDidNotLoad(context, rules);
      const gate = new LocalGate(rules.policies, {
        agentName: options.agent,
      });
      const verdict = requestsFor(action, options)
        .map((request) => gate.evaluate(request))
        .reduce((worst, each) =>
          (SEVERITY[each.effect] ?? 0) > (SEVERITY[worst.effect] ?? 0) ? each : worst,
        );

      const rule = verdict.matchedPolicies[0];
      // A refusal that names no way forward is a dead end the agent cannot act on.
      const alternative = verdict.alternative;
      flow.rows(action, [
        /* Upper case, the way `why` renders a verdict: this is the word a
           reader is looking for and the one they paste into an issue. */
        {
          label: 'verdict',
          value: style.effect(verdict.effect, verdict.effect.toUpperCase()),
        },
        { label: 'reason', value: verdict.reason },
        ...(rule === undefined ? [] : [{ label: 'rule', value: rule.name }]),
        ...(alternative === undefined
          ? []
          : [
              {
                label: 'instead',
                value:
                  alternative.resource === undefined
                    ? alternative.action
                    : `${alternative.action} ${alternative.resource}`,
              },
            ]),
      ]);
      flow.close(
        style.effect(verdict.effect, `${verdict.effect.toUpperCase()}  ${action}`),
      );
      flow.hint('Nothing was run, and nothing on this machine changed.');
      if (verdict.effect !== DECISION_EFFECT.ALLOW) process.exitCode = 1;
    });
}

/**
 * Every rule file this machine would load, checked. A file listed here belongs to some
 * repository on the disk, so the path is printed in full: "invalid policy document" is
 * not a fix if the reader cannot tell which of eight checkouts it means.
 */
async function checkPolicyFiles(
  context: CliContext,
  file: string | undefined,
  prune: boolean,
): Promise<void> {
  const { flow, style } = context;
  const files = file !== undefined ? [file] : await allPolicyFiles();

  if (files.length === 0) {
    flow.close('No rule files on this machine.');
    flow.hint('Write some with "memnox protect".');
    return;
  }

  const set = await loadPolicySet(files);
  // A registered checkout that moved is not a fault to fix, so it is said separately.
  const forgotten =
    set.missing.length > 0 && prune && file === undefined
      ? await forgetPolicyFiles(homedir(), set.missing).then(() => set.missing.length)
      : 0;

  flow.list('Rule files', [
    ...set.loaded.map((loaded) => ({
      tone: TONE.OK,
      text: `${loaded.file}  ${loaded.rules} rule(s)`,
    })),
    ...set.missing.map((missing) => ({
      tone: TONE.DIM,
      text: `${missing}  gone`,
      detail: [forgotten > 0 ? 'forgotten, because --prune was given' : undefined],
    })),
    ...set.unreadable.map((broken) => ({
      tone: TONE.WARN,
      text: `${broken.file}  would not load`,
      detail: broken.issues,
    })),
  ]);

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
  }
  // Non-zero, so a CI step that checks the rule files fails on a broken one.
  if (set.unreadable.length > 0) process.exitCode = 1;
}

/**
 * The one thing a file can be wrong about that this version knows the answer to.
 *
 * Only the effects an earlier spelling called something else, and only where the file
 * would otherwise not load at all. Everything else a check reports is somebody's to
 * decide: a machine that rewrote a rule on its own judgement would be the thing this
 * product exists to catch.
 */
async function fixRenamedEffects(
  context: CliContext,
  file: string | undefined,
): Promise<void> {
  const files = file !== undefined ? [resolve(file)] : await allPolicyFiles();
  let touched = 0;

  for (const path of files) {
    let source: string;
    try {
      source = await readFile(path, 'utf8');
    } catch {
      // Gone or unreadable: reported by the check that runs straight after this.
      continue;
    }
    const { text, renamed } = renameEffectsIn(source);
    if (renamed.length === 0) continue;

    const backup = backupPathFor(homedir(), path);
    await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
    await writeFile(backup, source, 'utf8');
    await writeFile(path, text, 'utf8');
    touched += 1;
    context.flow.list('Fixed', [
      {
        tone: TONE.OK,
        text: `${path}  ${renamed.length} effect(s)`,
        detail: [...new Set(renamed), `kept the original at ${backup}`],
      },
    ]);
  }
  if (touched === 0)
    context.flow.step('Nothing to fix', 'no file names a renamed effect');
}

/** The registry names every repository that registered itself; the cwd names this one. */
async function allPolicyFiles(): Promise<string[]> {
  return policyFilesInForce(homedir());
}
