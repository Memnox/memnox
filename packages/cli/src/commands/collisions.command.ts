import type { Command } from 'commander';
import type { ActionEvent } from '@memnox/core';
import { effectOfName, TOOL_EFFECT } from '@memnox/discovery';
import {
  concurrentWork,
  overlappingWork,
  type Collision,
  type OverlappingWork,
  type WorkObservation,
} from '@memnox/ledger';
import type { CliContext } from '../cli-context';
import { DEFAULT_BASE_URL } from '../defaults';

const DEFAULT_WINDOW_MINUTES = 30;
const DEFAULT_OVERLAP_DAYS = 7;
/** Enough history for a week of two agents' writes without reading the whole log. */
const HISTORY_LIMIT = 2_000;
const MINUTES = 60_000;

/**
 * Two agents in the same file, and two agents building the same thing. Both are read
 * out of the ledger, because both agents act through seams that record what they
 * touched. Reported, never refereed — opening the diff to decide which of them is
 * right is code review, and that is out of scope permanently.
 */
export function registerCollisionsCommand(
  program: Command,
  context: CliContext,
  now: () => string = () => new Date().toISOString(),
): void {
  program
    .command('collisions')
    .description('Two agents in one file, and two agents building the same thing')
    .option(
      '--window <minutes>',
      'how close two touches must be to collide',
      String(DEFAULT_WINDOW_MINUTES),
    )
    .option(
      '--days <n>',
      'days of history to read for duplicated work',
      String(DEFAULT_OVERLAP_DAYS),
    )
    .option('--json', 'emit the findings as JSON')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(
      async (options: {
        window: string;
        days: string;
        json?: boolean;
        url?: string;
        adminToken?: string;
      }) => {
        const windowMinutes = Number(options.window);
        const windowDays = Number(options.days);
        if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
          throw new Error('--window must be a positive number of minutes');
        }
        if (!Number.isFinite(windowDays) || windowDays <= 0) {
          throw new Error('--days must be a positive number');
        }

        const { client } = await context.connect(options);
        const at = now();
        const events = await client.queryAudit({
          from: new Date(Date.parse(at) - windowDays * 24 * 60 * MINUTES).toISOString(),
          limit: HISTORY_LIMIT,
        });
        const observations = events.flatMap(observationOf);

        const collisions = concurrentWork(observations, { now: at, windowMinutes });
        const duplicated = overlappingWork(observations, { now: at, windowDays });

        if (options.json === true) {
          context.out.line(JSON.stringify({ collisions, duplicated }, null, 2));
          return;
        }
        render(context, collisions, duplicated, windowDays);
      },
    );
}

/**
 * An event with no target names nothing two agents could be inside, so it is not an
 * observation. Whether it wrote is read off the action's verb, the same way a tool's
 * effect is — one verb list, so the two answers cannot drift apart.
 */
function observationOf(event: ActionEvent): WorkObservation[] {
  if (event.target === undefined) return [];
  const effect = effectOfName(event.action);
  return [
    {
      agentId: event.agentId,
      agentName: event.agentName,
      target: event.target,
      at: event.occurredAt,
      writing: effect === TOOL_EFFECT.WRITE || effect === TOOL_EFFECT.DESTRUCTIVE,
      ...(event.branch === undefined ? {} : { branch: event.branch }),
    },
  ];
}

function render(
  context: CliContext,
  collisions: readonly Collision[],
  duplicated: readonly OverlappingWork[],
  windowDays: number,
): void {
  const { out, style } = context;

  if (collisions.length === 0 && duplicated.length === 0) {
    out.line('No two agents have been inside the same work.');
    out.line(style.dim(`Read from ${windowDays} days of this machine's own record.`));
    return;
  }

  for (const collision of collisions) {
    out.line('');
    out.line(style.warn('⚠ CONCURRENT WORK'));
    out.line('');
    out.line(`  ${style.bold(collision.target)}`);
    out.line('');
    for (const agent of collision.agents) {
      const doing = agent.writing ? 'writing' : 'reading';
      out.line(`    ${agent.agentName.padEnd(16)}${doing.padEnd(10)}${agent.at}`);
    }
    out.line('');
    out.line(`  ${style.dim('One file, two agents, no shared awareness.')}`);
  }

  for (const overlap of duplicated) {
    out.line('');
    out.line(style.warn('⚠ DUPLICATE EFFORT'));
    out.line('');
    for (const agent of overlap.agents) {
      out.line(
        `  ${agent.agentName.padEnd(16)}${agent.branch ?? style.dim('no branch')}`,
      );
    }
    out.line('');
    out.line(`  same files    ${overlap.sharedTargets.join('\n                ')}`);
    out.line(`  since         ${overlap.since}`);
  }
  out.line('');
}
