import type { Command } from 'commander';
import { DECISION_EFFECT } from '@memnox/core';
import type { CliContext } from '../cli-context';
import { DEFAULT_BASE_URL } from '../defaults';
import { resolveProjectId } from '../project-identity';

const LABEL_WIDTH = 9;

/** Right-pads a label so the values line up whatever the style adds around them. */
const label = (text: string): string => `${text}`.padEnd(LABEL_WIDTH);

/** Where the command is being run; injected so tests never depend on the real cwd. */
type WorkingDirectory = () => string;

export function registerCheckCommand(
  program: Command,
  context: CliContext,
  cwd: WorkingDirectory = () => process.cwd(),
): void {
  program
    // Positional: `memnox check shell.execute "rm -rf /"` is the question being
    // asked; --action/--target still work for scripts already written that way.
    .command('check [action] [target]')
    .description('Ask the runtime for a decision on one action')
    .option('--token <token>', `agent token (default: the one from "memnox setup")`)
    .option('--action <action>', 'namespaced action, e.g. database.delete')
    .option('--target <target>', 'action target, e.g. production.users')
    .option('--env <environment>', 'environment, e.g. production')
    .option(
      '--project <name>',
      'governance scope (default: the project this directory declares)',
    )
    .option('--approval <id>', 'present a previously granted approval')
    .option('--session <id>', 'group this action into a session for replay')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .action(
      async (
        positionalAction: string | undefined,
        positionalTarget: string | undefined,
        options: {
          token?: string;
          action?: string;
          target?: string;
          env?: string;
          project?: string;
          approval?: string;
          session?: string;
          url?: string;
        },
      ) => {
        const { out, style } = context;
        const action = positionalAction ?? options.action;
        if (action === undefined) {
          throw new Error('Which action? Try:  memnox check shell.execute "rm -rf /"');
        }
        const target = positionalTarget ?? options.target;

        const { client, connection } = await context.connect(options);
        if (connection.token === undefined) {
          throw new Error(
            'No agent token. Pass --token, export MEMNOX_AGENT_TOKEN, or run "memnox setup" to store one.',
          );
        }

        // Without this the CLI silently misses every project-scoped rule: the
        // engine only applies them to a request that names the same project.
        const projectId = options.project ?? resolveProjectId(cwd());

        const decision = await client.check({
          action,
          target,
          environment: options.env,
          projectId,
          approvalId: options.approval,
          sessionId: options.session,
        });

        const symbol = style.symbol(decision.effect);
        const verdict = style.effect(
          decision.effect,
          style.bold(decision.effect.toUpperCase()),
        );
        out.line(
          `${label('Decision')}: ${symbol === '' ? '' : `${symbol} `}${verdict}`.trimEnd(),
        );
        out.line(
          `${label('Risk')}: ${style.risk(decision.riskLevel, decision.riskLevel)}`,
        );
        out.line(`${label('Reason')}: ${decision.reason}`);
        if (decision.matchedPolicies.length > 0) {
          out.line(
            `${label('Policies')}: ${decision.matchedPolicies.map((p) => p.name).join(', ')}`,
          );
        }
        if (decision.approvalId) out.line(`${label('Approval')}: ${decision.approvalId}`);
        if (decision.withheldEffect !== undefined) {
          out.line(
            `${label('Withheld')}: ${decision.withheldEffect} (this environment is only being monitored)`,
          );
        }

        // Hints go to the note channel so piping the verdict stays parseable.
        reportNextStep(context, decision.effect, decision.approvalId);
      },
    );
}

function reportNextStep(
  context: CliContext,
  effect: string,
  approvalId: string | undefined,
): void {
  if (effect !== DECISION_EFFECT.REQUIRE_APPROVAL || approvalId === undefined) return;
  context.out.note('');
  context.out.note(`→ A human approves it:  memnox approve ${approvalId}`);
  context.out.note(`→ Then retry with:      --approval ${approvalId}`);
}
