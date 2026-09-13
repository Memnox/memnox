import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { Command } from 'commander';
import type { MemnoxEvent } from '@memnox/core';
import type { CliContext } from '../cli-context';
import type { FlowRow } from '../flow';
import { withEvents } from '../event-store';
import { transcriptPathFor } from '../memnox-paths';

/** Enough to see what happened, short enough to read without paging. */
const TRANSCRIPT_LINES = 12;

/**
 * One action, in the process's own terms. The timeline says the deploy ran and exited
 * zero; the agent's account of it is a summary written by something with an interest in
 * the summary being good. This is neither.
 */
export function registerTraceCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
): void {
  program
    .command('trace <id>')
    .description('One action end to end: the rule, the outcome, and what it printed')
    .option('--json', 'machine-readable output')
    .action(async (id: string, options: { json?: boolean }) => {
      /* Before the lookup, not after it: a refusal is the likeliest thing this
         command says, and one printed loose reads as a crash. */
      if (options.json !== true) context.flow.open('memnox trace');
      await withEvents(home(), async (store) => {
        const rows = await store.query({ limit: 5000 });
        const event = rows.find((row) => row.id === id || row.id.startsWith(id));
        if (event === undefined) {
          throw new Error(
            `No action ${id} on this machine. "memnox timeline" lists what there is.`,
          );
        }
        if (options.json === true) {
          context.out.json(event);
          return;
        }
        render(context, event);
        await renderStreams(context, event, home());
      });
    });
}

function render(context: CliContext, event: MemnoxEvent): void {
  const { flow, style } = context;
  const at = (label: string, value: string | undefined): FlowRow | undefined =>
    value === undefined || value === '' ? undefined : { label, value };

  flow.rows(event.operation, [
    at('target', event.target),
    at('agent', event.agent),
    at('session', event.sessionId),
    at('at', event.at),
    at(
      'decision',
      style.effect(
        event.effect,
        `${event.effect}${event.mode === 'observe' ? ' (observing)' : ''}`,
      ),
    ),
    at('reason', event.reason),
    at('rule', event.rule === undefined ? undefined : ruleOf(event)),
    at('exit', event.exitCode === undefined ? undefined : String(event.exitCode)),
    at('took', event.durationMs === undefined ? undefined : `${event.durationMs} ms`),
    at('approved by', event.authorizedBy),
    // The digest, not the arguments: an argument list is where a secret would be.
    at('args', event.argsDigest),
    at('output', event.outputDigest),
  ]);
}

function ruleOf(event: MemnoxEvent): string {
  const rule = event.rule;
  if (rule === undefined) return '';
  const where = rule.file === undefined ? '' : `, ${rule.file}`;
  return `${rule.name}${where}`;
}

/**
 * The transcript, when the session kept one. Off by default and said so: a stream tap is
 * the one thing here that could hold a secret somebody printed, and it stays on the
 * machine, capped and bound by the same retention as everything else.
 */
async function renderStreams(
  context: CliContext,
  event: MemnoxEvent,
  home: string,
): Promise<void> {
  const { flow } = context;
  if (event.sessionId === undefined) {
    flow.close(closing(context, event));
    return;
  }

  let contents: string;
  try {
    contents = await readFile(transcriptPathFor(home, event.sessionId), 'utf8');
  } catch {
    // No transcript kept for that session, which is the default and not a failure.
    flow.close(closing(context, event));
    flow.hint(
      'No stream recorded for this session. Start the agent with "memnox run --transcript" to keep one.',
    );
    return;
  }

  const lines = contents.split('\n').filter((line) => line !== '');
  const tail = lines.slice(-TRANSCRIPT_LINES);
  flow.box(`What the session printed, last ${tail.length} of ${lines.length}`, tail);
  flow.close(closing(context, event));
}

/** The verdict and what it was about, in the one spelling the whole CLI uses. */
function closing(context: CliContext, event: MemnoxEvent): string {
  return context.style.effect(
    event.effect,
    `${event.effect.toUpperCase()}  ${event.operation}`,
  );
}
