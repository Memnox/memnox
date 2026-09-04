import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import { DECISION_EFFECT, LocalGate, normalizeShellCommand } from '@memnox/core';
import type { CliContext } from '../cli-context';
import { DEFAULT_POLICY_FILE } from '../defaults';

interface TestOptions {
  file: string;
  agent: string;
  target?: string;
}

/** A shell line is the shape people test with; the first segment is the action. */
function requestFor(
  action: string,
  options: TestOptions,
): Parameters<LocalGate['evaluate']>[0] {
  const segment = normalizeShellCommand(action).segments[0];
  return {
    action: segment ?? action,
    ...(options.target === undefined ? {} : { target: options.target }),
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
