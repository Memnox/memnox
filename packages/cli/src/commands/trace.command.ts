/** `memnox trace <id>`: one action end to end, in the process's own terms rather than the agent's. */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { Command } from 'commander';
import { ENFORCEMENT_MODE, LEDGER_LOOKUP_LIMIT, type MemnoxEvent } from '@memnox/core';
import type { CliContext } from '../cli-context';
import type { FlowRow } from '../flow';
import { withEvents } from '../event-store';
import { transcriptPathFor } from '../memnox-paths';

/** Enough to see what happened, short enough to read without paging. */
const TRANSCRIPT_LINES = 12;

/** The ledger's account of one action, rather than the agent's summary of it. */
export function registerTraceCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
): void {
  program
    .command('trace <id>')
    .description('One action end to end: the rule, the outcome, and what it printed')
    .option('--json', 'machine-readable output')
    .action(async (id: string, options: TraceOptions) =>
      runTrace(context, home, id, options),
    );
}

interface TraceOptions {
  json?: boolean;
}

/** One action in full: the command, the rule, the exit code and the output it kept. */
async function runTrace(
  context: CliContext,
  home: () => string,
  id: string,
  options: TraceOptions,
): Promise<void> {
  // Opened before the lookup, so the likeliest answer, a refusal, never reads as a crash.
  if (options.json !== true) context.flow.open('memnox trace');
  await withEvents(home(), async (store) => {
    const rows = await store.query({ limit: LEDGER_LOOKUP_LIMIT, withConfig: true });
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
    renderEvent(context, event);
    await renderStreams(context, event, home());
  });
}

/** A row only when there is something to put in it. */
function rowOf(label: string, value: string | undefined): FlowRow | undefined {
  return value === undefined || value === '' ? undefined : { label, value };
}

function renderEvent(context: CliContext, event: MemnoxEvent): void {
  const { flow, style } = context;
  const observing = event.mode === ENFORCEMENT_MODE.OBSERVE ? ' (observing)' : '';
  flow.rows(event.operation, [
    rowOf('target', event.target),
    rowOf('agent', event.agent),
    rowOf('session', event.sessionId),
    rowOf('at', event.at),
    rowOf('decision', style.effect(event.effect, `${event.effect}${observing}`)),
    rowOf('reason', event.reason),
    rowOf('rule', event.rule === undefined ? undefined : ruleOf(event)),
    rowOf('exit', event.exitCode === undefined ? undefined : String(event.exitCode)),
    rowOf('took', event.durationMs === undefined ? undefined : `${event.durationMs} ms`),
    rowOf('approved by', event.authorizedBy),
    // The digest, not the arguments: an argument list is where a secret would be.
    rowOf('args', event.argsDigest),
    rowOf('output', event.outputDigest),
  ]);
}

function ruleOf(event: MemnoxEvent): string {
  const rule = event.rule;
  if (rule === undefined) return '';
  const where = rule.file === undefined ? '' : `, ${rule.file}`;
  return `${rule.name}${where}`;
}

/**
 * The transcript, when the session kept one. Off by default because a stream tap could
 * hold a secret somebody printed, and it stays on the machine under the same retention.
 */
async function renderStreams(
  context: CliContext,
  event: MemnoxEvent,
  home: string,
): Promise<void> {
  const { flow } = context;
  if (event.sessionId === undefined) {
    flow.close(describeVerdict(context, event));
    return;
  }
  const contents = await readTranscript(home, event.sessionId);
  if (contents === null) {
    flow.close(describeVerdict(context, event));
    flow.hint(
      'No stream recorded for this session. Start the agent with "memnox run --transcript" to keep one.',
    );
    return;
  }
  const lines = contents.split('\n').filter((line) => line !== '');
  const tail = lines.slice(-TRANSCRIPT_LINES);
  flow.box(`What the session printed, last ${tail.length} of ${lines.length}`, tail);
  flow.close(describeVerdict(context, event));
}

/** Null when no transcript was kept, which is the default and not a failure. */
async function readTranscript(home: string, sessionId: string): Promise<string | null> {
  try {
    return await readFile(transcriptPathFor(home, sessionId), 'utf8');
  } catch {
    return null;
  }
}

/** The verdict and what it was about, in the one spelling the whole CLI uses. */
function describeVerdict(context: CliContext, event: MemnoxEvent): string {
  return context.style.effect(
    event.effect,
    `${event.effect.toUpperCase()}  ${event.operation}`,
  );
}
