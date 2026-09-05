import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { Command } from 'commander';
import type { MemnoxEvent } from '@memnox/core';
import type { CliContext } from '../cli-context';
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
  const { out, style } = context;
  const rows: [string, string | undefined][] = [
    ['action', event.operation],
    ['target', event.target],
    ['agent', event.agent],
    ['session', event.sessionId],
    ['at', event.at],
    ['decision', `${event.effect}${event.mode === 'observe' ? ' (observing)' : ''}`],
    ['reason', event.reason],
    ['rule', event.rule === undefined ? undefined : ruleOf(event)],
    ['exit', event.exitCode === undefined ? undefined : String(event.exitCode)],
    ['took', event.durationMs === undefined ? undefined : `${event.durationMs} ms`],
    ['approved by', event.authorizedBy],
    // The digest, not the arguments: an argument list is where a secret would be.
    ['args', event.argsDigest],
    ['output', event.outputDigest],
  ];
  const shown = rows.filter(([, value]) => value !== undefined && value !== '');
  const width = Math.max(...shown.map(([label]) => label.length));
  for (const [label, value] of shown) {
    out.line(`  ${style.dim(label.padEnd(width))}  ${value ?? ''}`);
  }
}

function ruleOf(event: MemnoxEvent): string {
  const rule = event.rule;
  if (rule === undefined) return '';
  const where = rule.file === undefined ? '' : ` — ${rule.file}`;
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
  const { out, style } = context;
  if (event.sessionId === undefined) return;

  let contents: string;
  try {
    contents = await readFile(transcriptPathFor(home, event.sessionId), 'utf8');
  } catch {
    out.line('');
    out.note(
      'No stream recorded for this session. Start the agent with "memnox run --transcript" to keep one.',
    );
    return;
  }

  const lines = contents.split('\n').filter((line) => line !== '');
  const tail = lines.slice(-TRANSCRIPT_LINES);
  out.line('');
  out.line(
    style.dim(`  what the session printed (last ${tail.length} of ${lines.length})`),
  );
  for (const line of tail) out.line(`  ${style.dim('│')} ${line}`);
}
