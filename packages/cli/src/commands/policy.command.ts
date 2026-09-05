import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import { DECISION_EFFECT, LocalGate, resolveAction } from '@memnox/core';
import type { CliContext } from '../cli-context';
import { resolvePolicyFile } from '../policy-path';

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
