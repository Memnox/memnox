import { homedir } from 'node:os';
import type { Command } from 'commander';
import {
  concurrentWork,
  overlappingWork,
  SqliteEventStore,
  type WorkObservation,
} from '@memnox/core';
import type { CliContext } from '../cli-context';

const DEFAULT_WINDOW_DAYS = 7;

/**
 * Two agents in one file, and two agents building one thing. Reported, never refereed:
 * which of them should stop is a question about the work, and nothing here knows that.
 */
export function registerCollisionsCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
  now: () => Date = () => new Date(),
): void {
  program
    .command('collisions')
    .description('Two agents in one file, and two agents building one thing')
    .option('--days <n>', 'how far back to look', String(DEFAULT_WINDOW_DAYS))
    .option('--json', 'machine-readable output')
    .action(async (options: { days: string; json?: boolean }) => {
      const days = Number(options.days);
      if (!Number.isFinite(days) || days <= 0) {
        throw new Error('--days takes a positive number of days.');
      }

      const moment = now().toISOString();
      const since = new Date(now().getTime() - days * 86_400_000).toISOString();
      const store = SqliteEventStore.forHome(home());

      try {
        const events = await store.query({ since });
        // Only what actually touched something: a refused attempt is not shared work.
        const observations: WorkObservation[] = events
          .filter((event) => event.target !== undefined && event.effect === 'allow')
          .map((event) => ({
            agentId: event.sessionId,
            agentName: event.agent,
            target: event.target as string,
            at: event.at,
            // Only a write can collide; two agents reading one file is not a problem.
            writing: event.class !== 'read',
          }));

        const concurrent = concurrentWork(observations, { now: moment });
        const overlapping = overlappingWork(observations, {
          now: moment,
          windowDays: days,
        });

        if (options.json === true) {
          context.out.line(JSON.stringify({ concurrent, overlapping }, null, 2));
          return;
        }

        const { out, style } = context;
        if (concurrent.length === 0 && overlapping.length === 0) {
          out.line(
            events.length === 0
              ? 'Nothing recorded yet, so there is nothing to compare.'
              : `No collisions in the last ${days} day(s).`,
          );
          return;
        }

        if (concurrent.length > 0) {
          out.line('');
          out.line(style.bold('TWO AGENTS IN ONE FILE'));
          out.line('');
          for (const collision of concurrent) {
            out.line(`  ${style.warn('!')}  ${collision.target}`);
            for (const agent of collision.agents) {
              const doing = agent.writing ? 'writing' : 'reading';
              out.line(`     ${agent.agentName}  ${doing}  ${style.dim(agent.at)}`);
            }
          }
        }

        if (overlapping.length > 0) {
          out.line('');
          out.line(style.bold('TWO AGENTS BUILDING ONE THING'));
          out.line('');
          for (const overlap of overlapping) {
            const names = overlap.agents.map((each) => each.agentName).join(' and ');
            out.line(
              `  ${style.warn('!')}  ${names}  ${style.dim(`since ${overlap.since}`)}`,
            );
            out.line(`     ${style.dim(overlap.sharedTargets.join(', '))}`);
          }
        }
        out.line('');
        // Refereeing this would be a claim about somebody's work that nothing here can make.
        out.note('Reported, not refereed — which one should stop is your call.');
      } finally {
        store.close();
      }
    });
}
