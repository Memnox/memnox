import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import {
  DECISION_EFFECT,
  loadPoliciesFromFile,
  loadPolicySet,
  LocalGate,
  MEMNOX_HOME,
  readPolicyRegistry,
  resolveAction,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { resolvePolicyFile } from '../policy-path';
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
function requestFor(
  input: string,
  options: TestOptions,
): Parameters<LocalGate['evaluate']>[0] {
  // Already a namespaced action, e.g. from a git hook.
  if (!input.includes(' ') && input.includes('.')) {
    return {
      action: input,
      ...(options.target === undefined ? {} : { target: options.target }),
    };
  }

  /* Split in order. `normalizeShellCommand` sorts flags ahead of positionals, which
     is right for spotting a destructive pattern in a shell string and wrong here: argv
     order is what a verb pattern matches against. */
  const argv = splitCommand(input);
  const binary = argv[0] ?? input;
  const resolved = resolveAction(binary, argv.slice(1), process.env);

  return {
    action: resolved.action,
    ...(options.target !== undefined
      ? { target: options.target }
      : resolved.target === undefined
        ? {}
        : { target: resolved.target }),
  };
}

export function registerPolicyCommand(program: Command, context: CliContext): void {
  const policy = program.command('policy').description('Inspect the rules in force');

  policy
    .command('check [file]')
    .description('Read every rule file on this machine and say what will not load')
    .option('--prune', 'forget registered files that are no longer on the disk')
    .action(async (file: string | undefined, options: { prune?: boolean }) => {
      await checkPolicyFiles(context, file, options.prune === true);
    });

  policy
    .command('use [file]')
    .description('Register a rule file, so the seams load it and not only "policy test"')
    .action(async (file: string | undefined) => {
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
      context.out.line(
        before.includes(path)
          ? `${path} was already registered; ${policies.length} rule(s) load at every seam.`
          : `Registered ${path} — ${policies.length} rule(s) now load at every seam.`,
      );
      context.out.note('Check it with "memnox doctor --wiring".');
    });

  policy
    .command('test <action>')
    .description('Evaluate one action against the rules, changing nothing')
    .option('-f, --file <path>', 'policy file (default: whichever exists)')
    .option('-a, --agent <name>', 'agent the rules are matched against', 'agent')
    .option('-t, --target <target>', 'what the action operates on')
    .action(async (action: string, options: TestOptions) => {
      const file = resolvePolicyFile(options.file);
      if (!existsSync(file)) {
        throw new Error(
          `No rules at ${file}. Write some first:  memnox protect --interactive`,
        );
      }
      const gate = await LocalGate.fromFiles([file], {
        agentName: options.agent,
      });
      const verdict = gate.evaluate(requestFor(action, options));

      context.out.line(`${verdict.effect.toUpperCase()}  ${action}`);
      context.out.line(`  reason  ${verdict.reason}`);
      const rule = verdict.matchedPolicies[0];
      if (rule !== undefined) context.out.line(`  rule    ${rule.name}`);
      // A refusal that names no way forward is a dead end the agent cannot act on.
      if (verdict.alternative !== undefined) {
        const { action: instead, resource } = verdict.alternative;
        context.out.line(
          `  instead ${resource === undefined ? instead : `${instead} ${resource}`}`,
        );
      }
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
  const { out, style } = context;
  const files = file !== undefined ? [file] : await allPolicyFiles();

  if (files.length === 0) {
    out.line('No rule files on this machine. Write some with "memnox protect".');
    return;
  }

  const set = await loadPolicySet(files);
  for (const loaded of set.loaded) {
    out.line(`${style.ok('ok')}      ${loaded.file}  ${loaded.rules} rule(s)`);
  }
  // A registered checkout that moved is not a fault to fix, so it is said separately.
  for (const missing of set.missing) {
    out.line(`${style.dim('gone')}    ${missing}`);
  }
  if (set.missing.length > 0 && prune && file === undefined) {
    await forgetPolicyFiles(homedir(), set.missing);
    out.line(`${style.dim('forgot')}  ${set.missing.length} path(s) that are gone`);
  }
  for (const broken of set.unreadable) {
    out.line(`${style.warn('broken')}  ${broken.file}`);
    for (const issue of broken.issues) out.line(`        ${issue}`);
  }

  out.line('');
  out.line(`${set.policies.length} rule(s) in force from ${set.loaded.length} file(s).`);
  if (set.missing.length > 0 && !prune) {
    out.note('Drop the paths that are gone with "memnox policy check --prune".');
  }
  // Non-zero, so a CI step that checks the rule files fails on a broken one.
  if (set.unreadable.length > 0) process.exitCode = 1;
}

/** The registry names every repository that registered itself; the cwd names this one. */
async function allPolicyFiles(): Promise<string[]> {
  const registered = await readPolicyRegistry(
    join(homedir(), MEMNOX_HOME, REGISTRY_FILE),
  );
  const here = resolvePolicyFile();
  const found = new Set(registered);
  if (existsSync(here)) found.add(here);
  return [...found];
}
