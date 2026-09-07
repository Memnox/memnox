import { homedir } from 'node:os';
import type { Command } from 'commander';
import {
  delegations,
  describeLevel,
  ENFORCEMENT_MODE,
  interruptions,
  loadOrCreateConfig,
  LocalGate,
  promotable,
  standingOf,
  type AutonomyLevel,
  type Delegation,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { withEvents } from '../event-store';
import { policySetInForce } from '../policy-path';

const DEFAULT_WINDOW_DAYS = 7;

/**
 * What could safely be handed over next.
 *
 * This is the screen the product is actually for. "What did my agent do" is a ledger
 * question and it has its own command; this one reads the same ledger backwards and
 * asks what a person has already decided often enough that being asked again is the
 * tool wasting their attention.
 *
 * Nothing here is a score and nothing is an estimate. Every number is a count of
 * something that happened, because this is a screen somebody is being asked to act on.
 */
export function registerNextCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
  now: () => Date = () => new Date(),
): void {
  program
    .command('next')
    .description('What you could safely let your agents do without being asked')
    .option('--since <window>', 'how far back to read, e.g. 30d', '30d')
    .option('--json', 'machine-readable output')
    .action(async (options: { since: string; json?: boolean }) => {
      const moment = now();
      const days = Number.parseInt(options.since, 10);
      const since = new Date(
        moment.getTime() - (Number.isNaN(days) ? 30 : days) * 24 * 60 * 60_000,
      ).toISOString();
      const week = new Date(
        moment.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60_000,
      ).toISOString();

      const events = await withEvents(home(), (store) =>
        store.query({ since, limit: 20_000 }),
      );
      const found = delegations(events);
      const ready = promotable(found);
      const asked = interruptions(events, week);

      const config = await loadOrCreateConfig(home());
      const rules = await policySetInForce(home());
      const gate =
        rules.policies.length === 0
          ? null
          : new LocalGate(rules.policies, { agentName: 'agent' });
      const standing = standingOf({
        enforcing: config.mode === ENFORCEMENT_MODE.ENFORCE,
        rules: gate?.rules().length ?? 0,
        asksInWindow: asked.total,
        actionsInWindow: events.filter((event) => event.at >= week).length,
      });

      if (options.json === true) {
        context.out.json({ standing, promotable: ready, interruptions: asked });
        return;
      }
      render(context, standing, ready, asked, found.length);
    });
}

function render(
  context: CliContext,
  standing: AutonomyLevel,
  ready: readonly Delegation[],
  asked: { total: number; byAction: { action: string; count: number }[] },
  seen: number,
): void {
  const { out, style } = context;

  out.line('');
  out.line(style.bold('WHERE YOU ARE'));
  out.line(`  ${standing} — ${describeLevel(standing)}`);

  if (ready.length > 0) {
    out.line('');
    out.line(style.bold('WHAT YOU COULD HAND OVER'));
    out.line('');
    for (const each of ready) {
      out.line(`  ${style.ok('+')}  ${each.action}`);
      out.line(`     ${style.dim(each.because)}`);
      out.line(
        `     ${style.dim(`memnox protect --allow ${each.action}  (or keep being asked)`)}`,
      );
    }
  }

  if (asked.total > 0) {
    out.line('');
    out.line(
      style.bold('WHAT INTERRUPTED YOU') +
        style.dim(`  ${asked.total} times in ${DEFAULT_WINDOW_DAYS} days`),
    );
    out.line('');
    for (const each of asked.byAction.slice(0, 5)) {
      out.line(`  ${String(each.count).padStart(4)}  ${each.action}`);
    }
  }

  out.line('');
  if (ready.length === 0 && seen === 0) {
    // Nothing has been asked yet, which is not the same as nothing being delegable.
    out.line('Nothing has been held for you yet, so there is nothing to hand over.');
    out.note('Run an agent under "memnox run" for a few days first.');
    return;
  }
  if (ready.length === 0) {
    out.line(
      `${seen} action(s) have been held for you, and none has been approved often enough to be a habit yet.`,
    );
    return;
  }
  /* A count, never hours: "six hours a week you could get back" is a number nobody can
     check, on a screen somebody is being asked to act on. */
  out.line(
    `${ready.length} thing(s) you have already said yes to enough times that being asked again is the tool wasting your attention.`,
  );
}
