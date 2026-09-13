import { homedir } from 'node:os';
import type { Command } from 'commander';
import { writeFile } from 'node:fs/promises';
import {
  buildBundle,
  DECISION_EFFECT,
  generateKeys,
  verbForAction,
  verbTableFor,
  loadOrCreateConfig,
  type DecisionEffect,
  type EventQuery,
  type MemnoxEvent,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { DAY_MS, since } from '../duration';
import { withEvents } from '../event-store';

const DEFAULT_LIMIT = 200;

/** `--only` takes an effect, so a reader can ask for just what did not proceed. */
const ONLY: Readonly<Record<string, DecisionEffect[]>> = {
  allow: [DECISION_EFFECT.ALLOW],
  ask: [DECISION_EFFECT.ASK],
  deny: [DECISION_EFFECT.DENY],
  blocked: [DECISION_EFFECT.DENY, DECISION_EFFECT.ASK],
};

/** One action, as the cells of a timeline row. */
function cells(context: CliContext, event: MemnoxEvent): string[] {
  const { style } = context;
  const what =
    event.target === undefined ? event.operation : `${event.operation} ${event.target}`;
  /* Empty rather than a styled empty string: colour codes wrapped around
     nothing still print, and a trailing one shows as a stray escape. */
  const outcome =
    event.exitCode === undefined || event.exitCode === 0
      ? ''
      : style.dim(`exit ${event.exitCode}`);
  return [
    event.at.slice(11, 19),
    `${style.symbol(event.effect)}${style.effect(event.effect, event.effect)}`,
    // "preview" and "production" are the words that make a deploy line readable.
    `${what}${verbNote(event.operation)}`,
    outcome,
  ];
}

function render(context: CliContext, events: readonly MemnoxEvent[]): void {
  const { flow } = context;
  if (events.length === 0) {
    flow.close('Nothing recorded yet.');
    flow.hint('Wrap an agent with "memnox mcp wrap", then use it.');
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
    flow.table(
      `${first.agent}  ${sessionId}  ${first.at.slice(0, 10)}`,
      ['Time', '', 'Action', ''],
      rows.map((event) => cells(context, event)),
    );
  }
  flow.close(`${events.length} action(s) across ${sessions.size} session(s).`);
  flow.hint('One of them end to end: "memnox trace <id>".');
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
    .option('--export <format>', 'jsonl | json | bundle')
    .option('--out <path>', 'write the bundle here instead of to the terminal')
    .action(
      async (options: {
        session?: string;
        agent?: string;
        since?: string;
        only?: string;
        limit: string;
        export?: string;
        out?: string;
      }) => {
        if (options.export === undefined) context.flow.open('memnox timeline');
        if (options.only !== undefined && ONLY[options.only] === undefined) {
          throw new Error(
            `--only takes one of: ${Object.keys(ONLY).join(', ')}. Got "${options.only}".`,
          );
        }
        await withEvents(home(), async (store) => {
          const filter: EventQuery = { limit: Number(options.limit) };
          if (options.session !== undefined) filter.sessionId = options.session;
          if (options.agent !== undefined) filter.agent = options.agent;
          if (options.since !== undefined) filter.since = since(options.since, now());
          if (options.only !== undefined) filter.effects = ONLY[options.only];

          const events = await store.query(filter);

          if (options.export === 'bundle') {
            /* The bundle is the answer and a caller redirects it, so the rail
               moves to stderr rather than being drawn through the middle of
               what somebody is about to hand an auditor. */
            context.flow.commentary();
            context.flow.open('memnox timeline --export bundle');
            await writeBundle(context, events, filter, options.out, now());
            return;
          }
          if (options.export === 'jsonl') {
            // One row per line, never indented: jsonl is read by a tool, not a person.
            for (const event of events) context.out.line(JSON.stringify(event));
            return;
          }
          if (options.export === 'json') {
            context.out.json(events);
            return;
          }
          render(context, events);
        });
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
      const { flow } = context;
      flow.open('memnox purge');
      const config = await loadOrCreateConfig(home());
      const days =
        options.days === undefined ? config.retentionDays : Number(options.days);
      if (!Number.isInteger(days) || days <= 0) {
        throw new Error('--days takes a whole number of days above zero.');
      }

      const cutoff = new Date(now().getTime() - days * DAY_MS).toISOString();
      await withEvents(home(), async (store) => {
        if (options.dryRun === true) {
          const doomed = await store.query({ until: cutoff });
          flow.rows('Would drop', [
            { label: 'older than', value: `${days} days, before ${cutoff}` },
            { label: 'events', value: String(doomed.length) },
          ]);
          flow.close('Nothing was deleted.');
          flow.hint('Run it without --dry-run to drop them.');
          return;
        }
        const dropped = await store.pruneBefore(cutoff);
        flow.rows('Dropped', [
          { label: 'older than', value: `${days} days, before ${cutoff}` },
          { label: 'events', value: String(dropped) },
        ]);
        flow.close(`${dropped} event(s) older than ${days} days dropped.`);
      });
    });
}

/** The verb table's own note, so a timeline says which kind of deploy it was. */
function verbNote(operation: string): string {
  const verb = verbForAction(operation, verbTableFor);
  if (verb === null || verb.note === undefined) return '';
  return `  (${verb.note})`;
}

/**
 * A period of history, signed, so an auditor is looking at evidence rather than at a
 * file somebody could have edited. It states the range it covers and what was left
 * out — an export that quietly omitted a day would be worse than none, because
 * somebody would rely on it.
 */
async function writeBundle(
  context: CliContext,
  events: readonly MemnoxEvent[],
  filter: EventQuery,
  out: string | undefined,
  moment: Date,
): Promise<void> {
  const excluded: string[] = [];
  if (filter.limit !== undefined && events.length === filter.limit) {
    // Hitting the limit means older events exist and are not in here. Say so.
    excluded.push(
      `stopped at --limit ${filter.limit}; older events exist and are not included`,
    );
  }
  if (filter.effects !== undefined) {
    excluded.push(`only ${filter.effects.join(', ')} events were asked for`);
  }

  const { header, body } = buildBundle({
    events,
    range: {
      from: filter.since ?? events[0]?.at ?? moment.toISOString(),
      to: filter.until ?? events[events.length - 1]?.at ?? moment.toISOString(),
    },
    createdAt: moment.toISOString(),
    excluded,
    keys: generateKeys(),
  });

  const bundle = `${JSON.stringify(header, null, 2)}\n\n${body}\n`;
  const { flow } = context;
  if (out === undefined) {
    context.out.line(bundle);
    flow.close(`${header.events} event(s), signed.`);
    for (const each of excluded) flow.hint(`not included: ${each}`);
    return;
  }
  await writeFile(out, bundle, { encoding: 'utf8', mode: 0o600 });
  flow.rows('Written', [
    { label: 'file', value: out },
    { label: 'events', value: String(header.events) },
    { label: 'covers', value: `${header.range.from} to ${header.range.to}` },
  ]);
  flow.close(`${header.events} event(s), signed.`);
  flow.hint(`Check it with "memnox verify ${out}".`);
  for (const each of excluded) flow.hint(`not included: ${each}`);
}
