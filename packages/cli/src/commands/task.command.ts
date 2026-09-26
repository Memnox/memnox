/**
 * `memnox task`: what an agent working in this repository was asked to do, declared by a
 * person, for a session only the hooks see and whose id nobody knows. Actions outside
 * the paths it names are counted as drift, and `why` quotes the ask.
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import type { Command } from 'commander';

import {
  ownProcessEnv,
  REPOSITORY_TASK_HOURS,
  RepositoryTasks,
  TASK_INTENT,
} from '@memnox/core';

import type { CliContext } from '../cli-context';

interface SetOptions {
  paths?: string;
  hours?: string;
  intent?: string;
}

export function registerTaskCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
): void {
  const task = program
    .command('task')
    .description('What an agent in this repository was asked to do');
  task
    .command('set <statement>')
    .description('Declare it, with the paths it should stay inside')
    .option('--paths <paths>', 'comma separated, relative to the repository')
    .option('--hours <hours>', `how long it stands (default ${REPOSITORY_TASK_HOURS})`)
    .option(
      '--intent <intent>',
      'investigate: read anything, change nothing outside this machine',
    )
    .action(async (statement: string, options: SetOptions) =>
      runSet(context, home(), statement, options),
    );
  task
    .command('show')
    .description('The task standing for this repository')
    .action(async () => runShow(context, home()));
  task
    .command('clear')
    .description('Take it away before it runs out')
    .action(async () => runClear(context, home()));
}

async function runSet(
  context: CliContext,
  home: string,
  statement: string,
  options: SetOptions,
): Promise<void> {
  context.flow.open('memnox task set');
  const root = rootHere();
  const paths = pathsOf(root, options.paths);
  const hours = options.hours === undefined ? undefined : Number(options.hours);
  const task = await new RepositoryTasks(home).declare(
    root,
    {
      statement,
      scope: paths.length === 0 ? {} : { paths },
      ...intentOf(options.intent),
    },
    {
      now: new Date().toISOString(),
      ...(hours === undefined || Number.isNaN(hours) ? {} : { hours }),
    },
  );
  context.flow.rows('Declared', [
    { label: 'repository', value: root },
    { label: 'asked for', value: task.statement },
    ...(paths.length === 0 ? [] : [{ label: 'paths', value: paths.join(', ') }]),
    ...(task.intent === undefined
      ? []
      : [
          {
            label: 'intent',
            value: `${task.intent}: nothing outside this machine changes`,
          },
        ]),
    { label: 'until', value: task.until },
  ]);
  context.flow.close(
    'Actions outside these paths count as drift, and why quotes the ask.',
  );
}

function pathsOf(root: string, given: string | undefined): string[] {
  return (given ?? '')
    .split(',')
    .map((each) => each.trim())
    .filter((each) => each !== '')
    .map((each) => globFor(root, each));
}

function intentOf(given: string | undefined): {
  intent?: typeof TASK_INTENT.INVESTIGATE;
} {
  if (given === undefined) return {};
  if (given !== TASK_INTENT.INVESTIGATE) {
    throw new Error(`"${given}" is not an intent. The one there is: investigate.`);
  }
  return { intent: TASK_INTENT.INVESTIGATE };
}

async function runShow(context: CliContext, home: string): Promise<void> {
  const { flow } = context;
  flow.open('memnox task show');
  const task = await new RepositoryTasks(home).inForce(
    rootHere(),
    new Date().toISOString(),
  );
  if (task === null) {
    flow.close('No task stands for this repository.');
    flow.hint('memnox task set "<what the agent is here to do>" --paths src/payments');
    return;
  }
  flow.rows('Standing', [
    { label: 'asked for', value: task.statement },
    { label: 'paths', value: (task.scope.paths ?? []).join(', ') || 'any' },
    { label: 'until', value: task.until },
  ]);
  flow.close(`Declared ${task.declaredAt}.`);
}

async function runClear(context: CliContext, home: string): Promise<void> {
  context.flow.open('memnox task clear');
  await new RepositoryTasks(home).clear(rootHere());
  context.flow.close('No task stands for this repository now.');
}

/** A directory is everything under it; a glob is taken as written. */
function globFor(root: string, path: string): string {
  const absolute = isAbsolute(path) ? path : join(root, path);
  return absolute.includes('*') ? absolute : `${absolute.replace(/\/+$/, '')}/**`;
}

function rootHere(): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      // The real git: the one on PATH may be the interceptor, which would rule on this.
      env: ownProcessEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // Outside a repository the directory itself is the scope somebody meant.
    return process.cwd();
  }
}
