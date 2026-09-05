import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import {
  classifyBinary,
  DECISION_EFFECT,
  LocalGate,
  normalizeShellCommand,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { DEFAULT_POLICY_FILE } from '../defaults';

interface TestOptions {
  file: string;
  agent: string;
  target?: string;
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

  const segment = normalizeShellCommand(input).segments[0] ?? input;
  const argv = segment.split(/\s+/).filter((word) => word !== '');
  const binary = argv[0] ?? input;
  const classified = classifyBinary(binary, argv.slice(1));

  return {
    action: classified === null ? 'shell.execute' : classified.action,
    ...(options.target !== undefined
      ? { target: options.target }
      : classified?.target === undefined
        ? {}
        : { target: classified.target }),
  };
}

export function registerPolicyCommand(program: Command, context: CliContext): void {
  const policy = program.command('policy').description('Inspect the rules in force');

  policy
    .command('test <action>')
    .description('Evaluate one action against the rules, changing nothing')
    .option('-f, --file <path>', 'policy file', DEFAULT_POLICY_FILE)
    .option('-a, --agent <name>', 'agent the rules are matched against', 'agent')
    .option('-t, --target <target>', 'what the action operates on')
    .action(async (action: string, options: TestOptions) => {
      if (!existsSync(options.file)) {
        throw new Error(
          `No rules at ${options.file}. Write some first:  memnox protect --from-scan`,
        );
      }
      const gate = await LocalGate.fromFiles([options.file], {
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
