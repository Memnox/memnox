import type { Command } from 'commander';
import { describeStateFact, STATE_FACT_KIND, type StateFactKind } from '@memnox/core';
import type { CliContext } from '../cli-context';
import { DEFAULT_BASE_URL } from '../defaults';

const KIND_WIDTH = 14;
const VALID_KINDS: readonly string[] = Object.values(STATE_FACT_KIND);

interface ListOptions {
  json?: boolean;
  url?: string;
  adminToken?: string;
}

interface DeclareOptions extends ListOptions {
  scope: string;
  reason: string;
  source: string;
  until: string;
}

/**
 * What is true right now, which is the one thing an agent has no way to find out for
 * itself. A freeze, an open incident, a hold: each narrows what may happen while it
 * lasts, and every one of them expires, because a freeze that outlives its incident
 * is worse than no freeze at all.
 *
 * Memnox honours a fact; it never infers one. Where the fact comes from — a channel,
 * an incident tool — is the cloud's half.
 */
export function registerStateCommand(program: Command, context: CliContext): void {
  const state = program
    .command('state')
    .description('What is in force right now: a freeze, an incident, a hold')
    .option('--json', 'emit the facts as JSON')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(async function (this: Command) {
      const options = this.opts() as ListOptions;
      const { client } = await context.connect(options);
      const facts = await client.listState();

      if (options.json === true) {
        context.out.line(JSON.stringify(facts, null, 2));
        return;
      }

      const { out, style } = context;
      out.line('');
      out.line(style.bold('IN FORCE'));
      if (facts.inForce.length === 0) {
        // Honest when empty: nothing is narrowing anything on this runtime.
        out.line(`  ${style.dim('nothing — every action is decided on rules alone')}`);
      }
      for (const fact of facts.inForce) {
        out.line(`  ${fact.kind.padEnd(KIND_WIDTH)} ${describeStateFact(fact)}`);
        out.line(`  ${' '.repeat(KIND_WIDTH)} ${style.dim(fact.id)}`);
      }

      if (facts.lapsed.length > 0) {
        out.line('');
        out.line(style.bold('LAPSED'));
        /* Shown because the question "why did that get through" is usually answered
           by a freeze that expired, not by a rule that was missing. */
        for (const fact of facts.lapsed) {
          out.line(`  ${style.dim(describeStateFact(fact))}`);
        }
      }
      out.line('');
    });

  state
    .command('declare <kind>')
    .description(`Record a condition in force — one of: ${VALID_KINDS.join(', ')}`)
    .requiredOption('--scope <names>', 'what it covers, comma separated')
    .requiredOption('--reason <text>', 'why, verbatim from whoever declared it')
    .requiredOption('--source <who>', 'who said so, so it can be argued with')
    .requiredOption('--until <iso>', 'when it expires — mandatory, never open ended')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(async (kind: string, options: DeclareOptions) => {
      if (!VALID_KINDS.includes(kind)) {
        throw new Error(`unknown kind "${kind}" — one of: ${VALID_KINDS.join(', ')}`);
      }
      const { client } = await context.connect(options);
      const fact = await client.declareState({
        kind: kind as StateFactKind,
        scope: options.scope.split(',').map((each) => each.trim()),
        reason: options.reason,
        source: options.source,
        validUntil: options.until,
      });
      context.out.line(`In force: ${describeStateFact(fact)}`);
      context.out.line(`Lift it with: memnox state lift ${fact.id}`);
    });

  state
    .command('lift <id>')
    .description('End a condition early, before its expiry')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(async (id: string, options: ListOptions) => {
      const { client } = await context.connect(options);
      await client.liftState(id);
      context.out.line(`Lifted ${id}`);
    });
}
