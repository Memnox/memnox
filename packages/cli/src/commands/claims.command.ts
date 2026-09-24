/**
 * `memnox claims`: what the agent said it did, against what the record says, reported and
 * never refereed. No model reads the transcript: the patterns are a checked-in table.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';

import type { Command } from 'commander';

import {
  CLAIM_VERDICT,
  checkClaims,
  LEDGER_SESSION_LIMIT,
  type CheckedClaim,
  type EventQuery,
} from '@memnox/core';

import type { CliContext } from '../cli-context';
import { TONE, type Tone } from '../flow';
import { withEvents } from '../event-store';
import { transcriptPathFor } from '../memnox-paths';

export function registerClaimsCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
): void {
  program
    .command('claims [session]')
    .description('Check what an agent said against what it actually did')
    .option('--file <path>', 'read the text from here instead of the transcript')
    .option('--json', 'machine-readable output')
    .action(async (session: string | undefined, options: ClaimsOptions) =>
      runClaims(context, home, session, options),
    );
}

interface ClaimsOptions {
  file?: string;
  json?: boolean;
}

/** What the agent said it did, checked against what the ledger recorded. */
async function runClaims(
  context: CliContext,
  home: () => string,
  session: string | undefined,
  options: ClaimsOptions,
): Promise<void> {
  if (options.json !== true) context.flow.open('memnox claims');
  const text = await readText(home(), session, options.file);
  if (text === null) {
    throw new Error(
      session === undefined
        ? 'Name a session, or pass --file. A transcript needs "memnox run --transcript".'
        : `No transcript for ${session}. Start the agent with "memnox run --transcript".`,
    );
  }

  const filter: EventQuery = { limit: LEDGER_SESSION_LIMIT };
  if (session !== undefined) filter.sessionId = session;

  const checked = await withEvents(home(), async (store) =>
    checkClaims(text, await store.query(filter)),
  );

  if (options.json === true) {
    context.out.json(checked);
    return;
  }
  renderClaims(context, checked);
}

/** The transcript kept for a session, or the file named instead, or null when neither exists. */
async function readText(
  home: string,
  session: string | undefined,
  file: string | undefined,
): Promise<string | null> {
  const path = file ?? (session === undefined ? null : transcriptPathFor(home, session));
  if (path === null) return null;
  try {
    return await readFile(path, 'utf8');
  } catch {
    // No transcript kept for that session, which is the default and not a failure.
    return null;
  }
}

/** Supported, contradicted, or neither, and the vocabulary keeps the three apart. */
function toneOf(claim: CheckedClaim): Tone {
  if (claim.verdict === CLAIM_VERDICT.SUPPORTED) return TONE.OK;
  if (claim.verdict === CLAIM_VERDICT.CONTRADICTED) return TONE.WARN;
  return TONE.DIM;
}

/** `contradicted` is the one that matters: it ran, it failed, and somebody was told otherwise. */
function renderClaims(context: CliContext, checked: readonly CheckedClaim[]): void {
  const { flow, style } = context;
  if (checked.length === 0) {
    flow.close('Nothing in that text reads as a claim about what was done.');
    return;
  }

  const contradicted = checked.filter(
    (claim) => claim.verdict === CLAIM_VERDICT.CONTRADICTED,
  );
  flow.list(
    'What was said, against what was recorded',
    checked.map((claim) => ({
      tone: toneOf(claim),
      text: `${claim.kind}: ${claim.said}`,
      detail: [claim.because],
    })),
  );

  if (contradicted.length > 0) {
    flow.close(
      style.warn(
        `${contradicted.length} claim(s) the record contradicts, of ${checked.length}.`,
      ),
    );
    flow.hint('"memnox why" on the failing action says more.');
    return;
  }
  flow.close(`${checked.length} claim(s) checked, none contradicted.`);
  // Said plainly, because "unsupported" is not "untrue" and reading it as one is the risk.
  flow.hint('Unsupported means nothing here recorded it, not that it did not happen.');
}
