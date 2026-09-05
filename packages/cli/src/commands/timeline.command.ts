import { homedir } from 'node:os';
import type { Command } from 'commander';
import {
  DECISION_EFFECT,
  loadOrCreateConfig,
  SqliteEventStore,
  type DecisionEffect,
  type EventQuery,
  type MemnoxEvent,
} from '@memnox/core';
import type { CliContext } from '../cli-context';

const DEFAULT_LIMIT = 200;

/** `--only` takes an effect, so a reader can ask for just what did not proceed. */
const ONLY: Readonly<Record<string, DecisionEffect[]>> = {
  allow: [DECISION_EFFECT.ALLOW],
  ask: [DECISION_EFFECT.ASK],
  deny: [DECISION_EFFECT.DENY],
  blocked: [DECISION_EFFECT.DENY, DECISION_EFFECT.ASK],
};

/** Relative times, because nobody types an ISO timestamp at a terminal. */
export function since(value: string, now: Date): string {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (match === null) {
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
      throw new Error(`--since takes 30m, 2h, 7d or an ISO timestamp. Got "${value}".`);
    }
    return new Date(parsed).toISOString();
  }
  const size = Number(match[1]);
  const unit = match[2] as 's' | 'm' | 'h' | 'd';
  const ms = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return new Date(now.getTime() - size * ms).toISOString();
}

function line(context: CliContext, event: MemnoxEvent): string {
  const { style } = context;
  const time = event.at.slice(11, 19);
  const mark = style.symbol(event.effect);
  const what =
    event.target === undefined ? event.operation : `${event.operation} ${event.target}`;
  const outcome =
    event.exitCode === undefined || event.exitCode === 0
      ? ''
      : style.dim(` exit ${event.exitCode}`);
  return `  ${time}  ${mark}${style.effect(event.effect, event.effect.padEnd(5))}  ${what}${outcome}`;
}

function render(context: CliContext, events: readonly MemnoxEvent[]): void {
  const { out, style } = context;
  if (events.length === 0) {
    out.line('Nothing recorded yet.');
    out.note('Wrap an agent with "memnox mcp wrap", then use it.');
    return;
  }

  // Grouped by session, because one session is one piece of work somebody did.
  const sessions = new Map<string, MemnoxEvent[]>();
  for (const event of events) {
    const rows = sessions.get(event.sessionId) ?? [];
    rows.push(event);
    sessions.set(event.sessionId, rows);
  }

  for (const [sessionId, rows] of sessions) {
    const first = rows[0] as MemnoxEvent;
    out.line('');
    out.line(style.bold(`${first.agent}  ${sessionId}  ${first.at.slice(0, 10)}`));
    for (const event of rows) out.line(line(context, event));
  }
  out.line('');
  out.line(`${events.length} action(s) across ${sessions.size} session(s).`);
}

export function registerTimelineCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
  now: () => Date = () => new Date(),
): void {
  program
    .command('timeline')
    .description('What the agents on this machine actually did, in order')
    .option('--session <id>', 'one session only')
    .option('--agent <name>', 'one agent only')
    .option('--since <when>', 'e.g. 30m, 2h, 7d, or an ISO timestamp')
    .option('--only <effect>', `allow | ask | deny | blocked`)
    .option('--limit <n>', 'how many actions', String(DEFAULT_LIMIT))
    .option('--export <format>', 'jsonl | json')
    .action(
      async (options: {
        session?: string;
        agent?: string;
        since?: string;
        only?: string;
        limit: string;
        export?: string;
      }) => {
        if (options.only !== undefined && ONLY[options.only] === undefined) {
          throw new Error(
            `--only takes one of: ${Object.keys(ONLY).join(', ')}. Got "${options.only}".`,
          );
        }
        const store = SqliteEventStore.forHome(home());
        try {
          const filter: EventQuery = { limit: Number(options.limit) };
          if (options.session !== undefined) filter.sessionId = options.session;
          if (options.agent !== undefined) filter.agent = options.agent;
          if (options.since !== undefined) filter.since = since(options.since, now());
          if (options.only !== undefined) filter.effects = ONLY[options.only];

          const events = await store.query(filter);

          if (options.export === 'jsonl') {
            for (const event of events) context.out.line(JSON.stringify(event));
            return;
          }
          if (options.export === 'json') {
            context.out.line(JSON.stringify(events, null, 2));
            return;
          }
          render(context, events);
        } finally {
          store.close();
        }
      },
    );
}

export function registerPurgeCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
  now: () => Date = () => new Date(),
): void {
  program
    .command('purge')
    .description('Drop history older than the retention window in your config')
    .option('--days <n>', 'override the configured retention for this run')
    .option('--dry-run', 'say what would go and delete nothing')
    .action(async (options: { days?: string; dryRun?: boolean }) => {
      const config = await loadOrCreateConfig(home());
      const days =
        options.days === undefined ? config.retentionDays : Number(options.days);
      if (!Number.isInteger(days) || days <= 0) {
        throw new Error('--days takes a whole number of days above zero.');
      }

      const cutoff = new Date(now().getTime() - days * 86_400_000).toISOString();
      const store = SqliteEventStore.forHome(home());
      try {
        if (options.dryRun === true) {
          const doomed = await store.query({ until: cutoff });
          context.out.line(
            `${doomed.length} event(s) are older than ${days} days. Nothing was deleted.`,
          );
          return;
        }
        const dropped = await store.pruneBefore(cutoff);
        context.out.line(`${dropped} event(s) older than ${days} days dropped.`);
      } finally {
        store.close();
      }
    });
}
