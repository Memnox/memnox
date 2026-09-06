import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { Command } from 'commander';
import {
  CLAIM_VERDICT,
  checkClaims,
  type CheckedClaim,
  type EventQuery,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { withEvents } from '../event-store';
import { transcriptPathFor } from '../memnox-paths';

/**
 * What the agent said it did, against what the record says it did.
 *
 * Reported, never refereed, and the vocabulary is chosen so it stays that way:
 * `unsupported` means this machine holds nothing that would have produced the claim,
 * which is very often work that happened somewhere it cannot see. Calling that a lie
 * would be an accusation built on a gap. `contradicted` is the one that matters — it
 * ran, and it failed, and somebody was told otherwise.
 *
 * No model reads the transcript. The patterns are a table, checked in and reviewable.
 */
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
    .action(
      async (session: string | undefined, options: { file?: string; json?: boolean }) => {
        const text = await readText(home(), session, options.file);
        if (text === null) {
          throw new Error(
            session === undefined
              ? 'Name a session, or pass --file. A transcript needs "memnox run --transcript".'
              : `No transcript for ${session}. Start the agent with "memnox run --transcript".`,
          );
        }

        const filter: EventQuery = { limit: 2000 };
        if (session !== undefined) filter.sessionId = session;

        const checked = await withEvents(home(), async (store) =>
          checkClaims(text, await store.query(filter)),
        );

        if (options.json === true) {
          context.out.json(checked);
          return;
        }
        render(context, checked);
      },
    );
}

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

function render(context: CliContext, checked: readonly CheckedClaim[]): void {
  const { out, style } = context;
  if (checked.length === 0) {
    out.line('Nothing in that text reads as a claim about what was done.');
    return;
  }

  const contradicted = checked.filter(
    (claim) => claim.verdict === CLAIM_VERDICT.CONTRADICTED,
  );
  for (const claim of checked) {
    const mark =
      claim.verdict === CLAIM_VERDICT.SUPPORTED
        ? style.ok('/')
        : claim.verdict === CLAIM_VERDICT.CONTRADICTED
          ? style.warn('!')
          : style.dim('?');
    out.line(`  ${mark}  ${claim.kind}: ${claim.said}`);
    out.line(`     ${style.dim(claim.because)}`);
  }

  if (contradicted.length > 0) {
    out.note(
      `${contradicted.length} claim(s) the record contradicts. "memnox why" on the failing action says more.`,
    );
    return;
  }
  // Said plainly, because "unsupported" is not "untrue" and reading it as one is the risk.
  out.note('Unsupported means nothing here recorded it, not that it did not happen.');
}
