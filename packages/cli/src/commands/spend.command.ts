import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Command } from 'commander';
import {
  DECISION_EFFECT,
  ENFORCEMENT_MODE,
  EVENT_SCHEMA_VERSION,
  EVENT_SURFACE,
  SESSION_VAR,
  validateEvent,
  type MemnoxEvent,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { withEvents } from '../event-store';

/** What a reported spend is called when the caller does not say. */
const DEFAULT_OPERATION = 'llm.completion';

/**
 * What a run cost, reported by the thing that knows.
 *
 * Memnox prices nothing. An MCP call's model spend is knowable to the agent and to
 * nobody else on this machine, so the alternative to being told is a made-up number —
 * and a figure nobody can derive is the one that makes a reader stop trusting the rest
 * of the output. This is the seam a wrapper, a CI step or the agent itself reports
 * through, and everything that counts dollars counts these rows and no others.
 */
export function registerSpendCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
  now: () => Date = () => new Date(),
  newId: () => string = randomUUID,
): void {
  program
    .command('spend <usd>')
    .description('Record what an agent spent, so budgets and the breaker can see it')
    .option('-s, --session <id>', `session it belongs to (default: $${SESSION_VAR})`)
    .option('-a, --agent <name>', 'agent that spent it', 'agent')
    .option(
      '-f, --for <action>',
      'what it was spent on, in the action grammar rules use',
      DEFAULT_OPERATION,
    )
    .action(
      async (usd: string, options: { session?: string; agent: string; for: string }) => {
        const amount = Number(usd);
        if (!Number.isFinite(amount) || amount < 0) {
          throw new Error(`"${usd}" is not an amount. Pass dollars, like 0.42.`);
        }
        const session = options.session ?? process.env[SESSION_VAR];
        if (session === undefined || session === '') {
          throw new Error(
            'No session to attribute this to. Pass --session, or run the agent under "memnox run".',
          );
        }

        /* An allow, because it happened: `spentOn` counts only what ran, so a spend
           recorded as anything else would be a cost nothing ever charges against. */
        const event: MemnoxEvent = {
          id: `evt_${newId()}`,
          schemaVersion: EVENT_SCHEMA_VERSION,
          at: now().toISOString(),
          sessionId: session,
          agent: options.agent,
          actorType: 'agent',
          // A model call leaves this machine over the network, so that is the surface
          // it used. Inventing an enum value would edit a row the cloud ingests.
          surface: EVENT_SURFACE.NETWORK,
          operation: options.for,
          class: 'read',
          effect: DECISION_EFFECT.ALLOW,
          mode: ENFORCEMENT_MODE.OBSERVE,
          reason: 'reported spend',
          costUsd: amount,
        };
        const problems = validateEvent(event);
        if (problems.length > 0) throw new Error(problems.join('\n'));

        await withEvents(home(), (store) => store.append(event));

        context.out.line(
          `Recorded $${amount.toFixed(2)} against ${options.for} in ${session}.`,
        );
        context.out.note('See it with "memnox budget" and "memnox report".');
      },
    );
}
