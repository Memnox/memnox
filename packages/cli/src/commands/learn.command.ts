import { writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import type { LearnResponse } from '@memnox/sdk';
import type { CliContext } from '../cli-context';
import { DEFAULT_BASE_URL } from '../defaults';

const PERCENT = 100;
const DEFAULT_DAYS = 7;

/** Injected so a test never writes to the developer's disk. */
type FileWriter = (path: string, contents: string) => Promise<void>;

/**
 * You granted this agent everything and it used twenty seven percent of it. The number
 * is derived from this machine's own record, and the proposal it writes is a policy
 * file in the format a person writes — readable, editable, committable, diffable.
 */
export function registerLearnCommand(
  program: Command,
  context: CliContext,
  write: FileWriter = (path, contents) => writeFile(path, contents, 'utf8'),
): void {
  program
    .command('learn')
    .description(
      'What your agents actually used, what they never needed, and the rules that follow',
    )
    .option('--days <n>', `days of history to derive from (default: ${DEFAULT_DAYS})`)
    .option('--out <file>', 'write the proposed policy file here instead of printing it')
    .option('--json', 'emit the full analysis as JSON')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(
      async (options: {
        days?: string;
        out?: string;
        json?: boolean;
        url?: string;
        adminToken?: string;
      }) => {
        const { out, style } = context;
        const { client } = await context.connect(options);
        const days = options.days === undefined ? undefined : Number(options.days);
        if (days !== undefined && (!Number.isFinite(days) || days <= 0)) {
          throw new Error('--days must be a positive number');
        }

        const learned = await client.learn(days);
        if (options.json === true) {
          out.line(JSON.stringify(learned, null, 2));
          return;
        }

        if (learned.length === 0) {
          out.line('No agent has acted yet — there is nothing to learn from.');
          return;
        }

        if (options.out !== undefined) {
          await write(options.out, learned.map((each) => each.policyFile).join('\n'));
          out.note(`Wrote ${learned.length} proposal(s) to ${options.out}.`);
          out.note('Read it, edit it, then apply it. It is a proposal, not a policy.');
          return;
        }

        for (const agent of learned) render(context, agent);
        out.note('');
        out.note(
          style.dim(
            'Write it out with --out memnox.proposed.yaml, then read it before applying.',
          ),
        );
      },
    );
}

function render(context: CliContext, agent: LearnResponse): void {
  const { out, style } = context;
  const { proposal } = agent;
  const granted =
    proposal.allow.length + proposal.requireApproval.length + proposal.deny.length;
  const used = proposal.allow.length + proposal.requireApproval.length;

  out.line(style.bold(`${agent.agentName}  (${agent.agentId})`));
  out.line('');
  if (granted > 0) {
    out.line(
      `  You granted this agent ${granted} action(s) and it used ${Math.round((used / granted) * PERCENT)}% of them.`,
    );
  }
  out.line('');
  // The sample size travels with the answer, where it cannot be dropped in the retelling.
  const { derivedFrom } = proposal;
  out.line(
    style.dim(
      `  From ${derivedFrom.windowDays} day(s), ${derivedFrom.sessions} session(s), covering ${Math.round(derivedFrom.coverage * PERCENT)}% of its traffic.`,
    ),
  );
  out.line('');
  list(context, 'used', proposal.allow);
  list(context, 'used, still ask', proposal.requireApproval);
  list(context, 'never used', proposal.deny);
  out.line('');
}

function list(context: CliContext, label: string, actions: readonly string[]): void {
  if (actions.length === 0) return;
  context.out.line(`  ${context.style.bold(label)}`);
  for (const action of actions) context.out.line(`    ${action}`);
}
