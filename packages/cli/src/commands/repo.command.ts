/**
 * `memnox repo`: a repository an agent cloned starts on probation, because it is a
 * stranger's code, and work inside it is contained until somebody has looked and trusts it.
 */
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import type { Command } from 'commander';

import { PROBATION_KIND, ProbationRegister, probationsInForce } from '@memnox/core';

import type { CliContext } from '../cli-context';
import { runTrust } from '../probation-view';

export function registerRepoCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
): void {
  const repo = program.command('repo').description('Repositories an agent cloned');
  repo
    .command('list')
    .description('The cloned repositories still on probation')
    .action(async () => runList(context, home()));
  repo
    .command('trust <path>')
    .description("End a cloned repository's probation, so only your rules decide in it")
    .action(async (path: string) =>
      runTrust({
        context,
        home: home(),
        kind: PROBATION_KIND.REPOSITORY,
        name: resolve(path),
        now: new Date(),
      }),
    );
}

async function runList(context: CliContext, home: string): Promise<void> {
  const { flow } = context;
  flow.open('memnox repo list');
  const cloned = probationsInForce(
    await new ProbationRegister(home).all(),
    new Date(),
  ).filter((entry) => entry.kind === PROBATION_KIND.REPOSITORY);
  if (cloned.length === 0) {
    flow.close('No cloned repository is on probation.');
    return;
  }
  flow.rows(
    'On probation',
    cloned.map((entry) => ({
      label: entry.name,
      value: `${entry.label ?? ''}  until ${entry.until.slice(0, 10)}`.trim(),
    })),
  );
  flow.close(`${cloned.length} repository(s) where outward and destructive actions ask.`);
  flow.hint('memnox repo trust <path>   once you have looked');
}
