/**
 * `memnox allow`: a scope, for a while. "Claude may restart and reconfigure staging
 * payments-api for thirty minutes" is one approval rather than thirty, and it ends by
 * itself. It only ever answers a question a rule would have asked; a refusal stands.
 */
import { randomBytes } from 'node:crypto';
import { homedir, userInfo } from 'node:os';

import type { Command } from 'commander';

import {
  describeAllowance,
  FileAllowances,
  MOST_ALLOWANCE_MINUTES,
  type Allowance,
} from '@memnox/core';

import type { CliContext } from '../cli-context';
import { minutesFrom } from '../duration';

const DEFAULT_WINDOW = '30m';

interface AllowOptions {
  env?: string;
  target?: string;
  agent?: string;
  for: string;
  reason?: string;
  list?: boolean;
  revoke?: string;
}

export function registerAllowCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
): void {
  program
    .command('allow [actions]')
    .description('Allow a scope for a while, so the agent is not asked each time')
    .option('--env <names>', 'only in these environments, comma separated')
    .option('--target <patterns>', 'only on these targets, comma separated')
    .option('--agent <names>', 'only for these agents, comma separated')
    .option('--for <window>', 'how long, such as 30m or 2h', DEFAULT_WINDOW)
    .option('--reason <why>', 'why, in your words, kept with every decision it makes')
    .option('--list', 'what is allowed right now')
    .option('--revoke <id>', 'end one now')
    .action(async (actions: string | undefined, options: AllowOptions) =>
      runAllow(context, home(), actions, options),
    );
}

async function runAllow(
  context: CliContext,
  home: string,
  actions: string | undefined,
  options: AllowOptions,
): Promise<void> {
  context.flow.open('memnox allow');
  const store = new FileAllowances(home);
  const now = new Date();
  if (options.revoke !== undefined) return revoke(context, store, options.revoke, now);
  if (options.list === true || actions === undefined) {
    return list(context, await store.inForce(now.toISOString()));
  }
  const minutes = Math.min(minutesFrom(options.for, '--for'), MOST_ALLOWANCE_MINUTES);
  const allowance: Allowance = {
    id: `alw_${randomBytes(4).toString('hex')}`,
    actions: listOf(actions),
    ...fieldList('environments', options.env),
    ...fieldList('targets', options.target),
    ...fieldList('agents', options.agent),
    by: userInfo().username,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    since: now.toISOString(),
    until: new Date(now.getTime() + minutes * 60_000).toISOString(),
  };
  await store.add(allowance);
  context.flow.rows('Allowed', rowsOf(allowance));
  context.flow.close(`Asks inside this scope are allowed until ${allowance.until}.`);
  context.flow.hint(`memnox allow --revoke ${allowance.id}   end it now`);
}

async function revoke(
  context: CliContext,
  store: FileAllowances,
  id: string,
  now: Date,
): Promise<void> {
  const revoked = await store.revoke(id, now.toISOString());
  context.flow.close(
    revoked === null
      ? `No allowance ${id}.`
      : `${id} is ended: asks inside it ask again.`,
  );
}

function list(context: CliContext, allowances: readonly Allowance[]): void {
  if (allowances.length === 0) {
    context.flow.close('Nothing is allowed for a while right now.');
    context.flow.hint('memnox allow "railway.*" --env staging --for 30m');
    return;
  }
  for (const allowance of allowances) context.flow.rows(allowance.id, rowsOf(allowance));
  context.flow.close(`${allowances.length} allowance(s) in force.`);
}

function rowsOf(allowance: Allowance): { label: string; value: string }[] {
  return [
    { label: 'actions', value: allowance.actions.join(', ') },
    ...(allowance.environments === undefined
      ? []
      : [{ label: 'environments', value: allowance.environments.join(', ') }]),
    ...(allowance.targets === undefined
      ? []
      : [{ label: 'targets', value: allowance.targets.join(', ') }]),
    ...(allowance.agents === undefined
      ? []
      : [{ label: 'agents', value: allowance.agents.join(', ') }]),
    { label: 'says', value: describeAllowance(allowance) },
  ];
}

function listOf(raw: string): string[] {
  return raw
    .split(',')
    .map((each) => each.trim())
    .filter((each) => each !== '');
}

function fieldList<K extends 'environments' | 'targets' | 'agents'>(
  key: K,
  raw: string | undefined,
): Partial<Record<K, string[]>> {
  if (raw === undefined) return {};
  const values = listOf(raw);
  return values.length === 0 ? {} : ({ [key]: values } as Partial<Record<K, string[]>>);
}
