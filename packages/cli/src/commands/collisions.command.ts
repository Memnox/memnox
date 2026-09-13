import { homedir } from 'node:os';
import type { Command } from 'commander';
import {
  concurrentWork,
  overlappingWork,
  takesLease,
  type WorkObservation,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { TONE } from '../flow';
import { DAY_MS, windowDays } from '../duration';
import { withEvents } from '../event-store';

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
      if (options.json !== true) context.flow.open('memnox collisions');
      const days = windowDays(options.days, '--days');
      const moment = now().toISOString();
      const since = new Date(now().getTime() - days * DAY_MS).toISOString();

      await withEvents(home(), async (store) => {
        const events = await store.query({ since });
        // Only what actually touched something: a refused attempt is not shared work.
        const observations: WorkObservation[] = events
          .filter((event) => event.target !== undefined && event.effect === 'allow')
          .map((event) => ({
            agentId: event.sessionId,
            agentName: event.agent,
            target: event.target as string,
            at: event.at,
            /* Only a write can collide; two agents reading one file is not a problem.
               Asked of the same function the lease gate asks, because anything else
               was a second opinion: `class !== 'read'` counted `unknown` as a write,
               so two `git rev-parse` reads were reported as two agents fighting over a
               file called "rev-parse". A conflict nobody is having is worse than no
               report, since it is the screen that asks somebody to stop working. */
            writing: takesLease(event.class),
          }));

        const concurrent = concurrentWork(observations, { now: moment });
        const overlapping = overlappingWork(observations, {
          now: moment,
          windowDays: days,
        });

        if (options.json === true) {
          context.out.json({ concurrent, overlapping });
          return;
        }

        const { flow } = context;
        if (concurrent.length === 0 && overlapping.length === 0) {
          flow.close(
            events.length === 0
              ? 'Nothing recorded yet, so there is nothing to compare.'
              : `No collisions in the last ${days} day(s).`,
          );
          return;
        }

        if (concurrent.length > 0) {
          flow.list(
            'Two agents in one file',
            concurrent.map((collision) => ({
              tone: TONE.WARN,
              text: collision.target,
              detail: collision.agents.map(
                (agent) =>
                  `${agent.agentName}  ${agent.writing ? 'writing' : 'reading'}  ${agent.at}`,
              ),
            })),
          );
        }

        if (overlapping.length > 0) {
          flow.list(
            'Two agents building one thing',
            overlapping.map((overlap) => ({
              tone: TONE.WARN,
              text: `${overlap.agents.map((each) => each.agentName).join(' and ')}, since ${overlap.since}`,
              detail: [overlap.sharedTargets.join(', ')],
            })),
          );
        }
        flow.close(
          `${concurrent.length} file(s) contended, ${overlapping.length} overlapping piece(s) of work.`,
        );
        // Refereeing this would be a claim about somebody's work that nothing here can make.
        flow.hint('Reported, not refereed: which one should stop is your call.');
      });
    });
}
