import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { readAccount } from '../sync/account';
import { orgPolicyPath, PULL_OUTCOME, pullBundle, type PullResult } from '../sync/bundle';
import { CloudUnreachable } from '../sync/client';

/**
 * Pulling the workspace's rules, and saying where this machine stands.
 *
 * Run by the daemon on its heartbeat; this command is what a person reaches for
 * when they want it now, or want to know why the rules look old.
 */
export function registerSyncCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
): void {
  const sync = program
    .command('sync')
    .description('Pull the rules this workspace publishes');

  sync
    .command('now', { isDefault: true })
    .description('Pull them now rather than waiting for the next heartbeat')
    .option('--json', 'machine-readable output')
    .action(async (options: { json?: boolean }) => {
      const account = await readAccount(home());
      if (account === null) {
        context.out.line('Not logged in, so there is nothing to pull.');
        context.out.note('Connect this machine with "memnox login --workspace <id>".');
        return;
      }

      let result: PullResult;
      try {
        result = await pullBundle(home(), account, await heldHash(home()));
      } catch (err) {
        if (!(err instanceof CloudUnreachable)) throw err;
        /* Not an error to report as one: a machine that cannot reach its
           control plane carries on enforcing what it last agreed to. */
        context.out.line(
          'Could not reach the control plane. The rules on disk still apply.',
        );
        return;
      }

      if (options.json === true) {
        context.out.json(result);
        return;
      }
      report(context, result);
    });
}

function report(context: CliContext, result: PullResult): void {
  const { out, style } = context;
  switch (result.outcome) {
    case PULL_OUTCOME.UNCHANGED:
      out.line('Already up to date.');
      return;
    case PULL_OUTCOME.APPLIED:
      out.line(
        `${style.ok('Pulled')} ${result.rules} rule(s) and ${result.conditions} condition(s).`,
      );
      out.note(`bundle ${result.hash}`);
      return;
    case PULL_OUTCOME.REFUSED:
      out.line(
        style.warn('That bundle would not load, so the previous one still applies.'),
      );
      out.note(result.because ?? 'no reason given');
      return;
    case PULL_OUTCOME.REVOKED:
      out.line(style.warn('This machine has been revoked.'));
      out.note(
        'The rules it already pulled still apply. Run "memnox login" to enrol again.',
      );
      return;
    case PULL_OUTCOME.LAPSED:
      out.line(
        style.warn('The subscription has lapsed, so the rules are frozen as they are.'),
      );
      out.note(
        'Nothing has been loosened; this machine enforces exactly what it last agreed to.',
      );
      return;
  }
}

/** The hash of what is already on disk, so an unchanged bundle costs one 304. */
async function heldHash(home: string): Promise<string | undefined> {
  try {
    const document = JSON.parse(await readFile(orgPolicyPath(home), 'utf8')) as {
      bundleHash?: string;
    };
    return document.bundleHash;
  } catch {
    return undefined; // Nothing pulled yet.
  }
}
