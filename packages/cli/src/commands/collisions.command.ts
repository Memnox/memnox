import { homedir } from 'node:os';

import type { Command } from 'commander';

import {
  concurrentWork,
  overlappingWork,
  takesLease,
  type Collision,
  type MemnoxEvent,
  type OverlappingWork,
  type WorkObservation,
} from '@memnox/core';
import { DECISION_EFFECT } from '@memnox/core';

import type { CliContext } from '../cli-context';
import { TONE } from '../flow';
import { DAY_MS, windowDays } from '../duration';
import { withEvents } from '../event-store';

/**
 * `memnox collisions`: two agents in one file, and two agents building one thing.
 * Reported, never refereed: which of them should stop is a question about the work.
 */

const DEFAULT_WINDOW_DAYS = 7;

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
    .action(async (options: CollisionsOptions) =>
      runCollisions(context, home, now, options),
    );
}

interface CollisionsOptions {
  days: string;
  json?: boolean;
}

/** Two agents in one file, and two agents building one thing, over a window. */
async function runCollisions(
  context: CliContext,
  home: () => string,
  now: () => Date,
  options: CollisionsOptions,
): Promise<void> {
  if (options.json !== true) context.flow.open('memnox collisions');
  const days = windowDays(options.days, '--days');
  const moment = now();
  const since = new Date(moment.getTime() - days * DAY_MS).toISOString();

  await withEvents(home(), async (store) => {
    const events = await store.query({ since });
    const observations = observationsOf(events);
    const at = moment.toISOString();
    const concurrent = concurrentWork(observations, { now: at });
    const overlapping = overlappingWork(observations, { now: at, windowDays: days });

    if (options.json === true) {
      context.out.json({ concurrent, overlapping });
      return;
    }
    if (concurrent.length === 0 && overlapping.length === 0) {
      context.flow.close(
        events.length === 0
          ? 'Nothing recorded yet, so there is nothing to compare.'
          : `No collisions in the last ${days} day(s).`,
      );
      return;
    }
    renderCollisions(context, concurrent, overlapping);
  });
}

/** Only what actually touched something: a refused attempt is not shared work. */
function observationsOf(events: readonly MemnoxEvent[]): WorkObservation[] {
  return events.flatMap((event) =>
    event.target !== undefined && event.effect === DECISION_EFFECT.ALLOW
      ? [
          {
            agentId: event.sessionId,
            agentName: event.agent,
            target: event.target,
            at: event.at,
            // Asked of the same function the lease gate asks, so the two agree on what writes.
            writing: takesLease(event.class),
          },
        ]
      : [],
  );
}

function renderCollisions(
  context: CliContext,
  concurrent: readonly Collision[],
  overlapping: readonly OverlappingWork[],
): void {
  const { flow } = context;
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
}
