import { homedir } from 'node:os';
import type { Command } from 'commander';
import { DECISION_EFFECT, SqliteEventStore, type MemnoxEvent } from '@memnox/core';
import type { CliContext } from '../cli-context';

const LABEL_WIDTH = 14;

function row(context: CliContext, label: string, value: string): void {
  context.out.line(`  ${label.padEnd(LABEL_WIDTH)}${value}`);
}

/**
 * Read back from the row, never recomputed. Re-evaluating today's rules against
 * yesterday's action would answer a different question from the one asked, and answer
 * it confidently.
 */
function render(context: CliContext, event: MemnoxEvent): void {
  const { out, style } = context;
  out.line('');
  out.line(
    `${style.effect(event.effect, event.effect.toUpperCase())}  ${event.operation}${
      event.target === undefined ? '' : ` ${event.target}`
    }`,
  );
  out.line('');
  row(context, 'when', event.at);
  row(context, 'agent', `${event.agent} (${event.actorType})`);
  row(context, 'surface', event.surface);
  row(context, 'class', event.class);
  row(context, 'reason', event.reason);

  const rule = event.rule;
  if (rule === undefined) {
    row(context, 'rule', 'none matched — the default for this mode applied');
  } else {
    const at = rule.line === undefined ? rule.file : `${rule.file}:${rule.line}`;
    row(context, 'rule', `${rule.name}  (${rule.layer} layer)`);
    row(context, 'declared in', at);
  }

  if (event.policyHash !== undefined) {
    row(context, 'ruleset', `${event.policyHash} — the rules in force at the time`);
  }
  if (event.mode !== 'enforce' && event.shadowEffect !== undefined) {
    row(
      context,
      'would have',
      `${event.shadowEffect.toUpperCase()} in enforce; the mode was ${event.mode}`,
    );
  }
  if (event.authorizedBy !== undefined) {
    row(context, 'released by', event.authorizedBy);
  }

  const alternative = event.alternative;
  if (alternative !== undefined) {
    const instead =
      alternative.resource === undefined
        ? alternative.action
        : `${alternative.action} ${alternative.resource}`;
    out.line('');
    out.line(`  Instead:  ${instead}`);
    if (alternative.note !== '') out.line(`            ${style.dim(alternative.note)}`);
  }
  out.line('');
}

function renderEvidence(context: CliContext, event: MemnoxEvent): void {
  const { out } = context;
  out.line('  Evidence');
  row(context, '  event', event.id);
  if (event.argsDigest !== undefined) {
    // The digest, never the arguments: this is the line that keeps the ledger dull.
    row(context, '  arguments', `${event.argsDigest} (a hash; the payload never left)`);
  }
  if (event.exitCode !== undefined) row(context, '  exit code', String(event.exitCode));
  if (event.durationMs !== undefined) row(context, '  took', `${event.durationMs}ms`);
  if (event.execution !== undefined) row(context, '  execution', event.execution);
  out.line('');
}

export function registerWhyCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
): void {
  program
    .command('why [id]')
    .description('Why the last thing that did not simply proceed was decided that way')
    .option('--allowed', 'explain the last allow instead')
    .option('--evidence', 'show the digests and the outcome behind it')
    .option('--json', 'machine-readable output')
    .action(
      async (
        id: string | undefined,
        options: { allowed?: boolean; evidence?: boolean; json?: boolean },
      ) => {
        const store = SqliteEventStore.forHome(home());
        try {
          const effects =
            options.allowed === true
              ? [DECISION_EFFECT.ALLOW]
              : [DECISION_EFFECT.DENY, DECISION_EFFECT.ASK];
          const rows = await store.query(
            id === undefined ? { effects, limit: 1 } : { limit: 500 },
          );
          const event =
            id === undefined
              ? rows[rows.length - 1]
              : rows.find((each) => each.id === id);

          if (event === undefined) {
            context.out.line(
              id === undefined
                ? 'Nothing has been decided on this machine yet. Run an agent through "memnox mcp wrap" first.'
                : `No event with id "${id}".`,
            );
            return;
          }

          if (options.json === true) {
            context.out.line(JSON.stringify(event, null, 2));
            return;
          }
          render(context, event);
          if (options.evidence === true) renderEvidence(context, event);
        } finally {
          store.close();
        }
      },
    );
}
