import { homedir } from 'node:os';

import type { Command } from 'commander';

import { readAccount } from '@memnox/core';

import type { CliContext } from '../cli-context';
import { PULL_OUTCOME, type PullResult } from '../sync/bundle';
import { onePass, type Pass } from '../sync/heartbeat';
import { PUSH_OUTCOME, type PushResult } from '../sync/push';

/**
 * `memnox sync`: the daemon's heartbeat pass, now, for somebody who wants it immediately
 * or wants to know why the rules look old.
 */
export function registerSyncCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
): void {
  const sync = program
    .command('sync')
    .description('Pull the rules this workspace publishes, and send what happened');

  sync
    .command('now', { isDefault: true })
    .description('Do a pass now rather than waiting for the next heartbeat')
    .option('--json', 'machine-readable output')
    .action(async (options: SyncOptions) => runSync(context, home, options));
}

interface SyncOptions {
  json?: boolean;
}

/** One pass now: pull the rules, send what happened, say this machine is alive. */
async function runSync(
  context: CliContext,
  home: () => string,
  options: SyncOptions,
): Promise<void> {
  const { flow } = context;
  if (options.json !== true) flow.open('memnox sync');

  if ((await readAccount(home())) === null) {
    flow.close('Not logged in, so there is nothing to sync.');
    flow.hint('Connect this machine with "memnox login".');
    return;
  }

  const pass = await onePass(home());
  if (options.json === true) {
    context.out.json(pass);
    return;
  }
  renderPass(context, pass);
}

function renderPass(context: CliContext, pass: Pass): void {
  const { flow, style } = context;
  if (pass.unreachable === true) {
    // Not an error: a machine that cannot reach its plane enforces what it last agreed to.
    flow.close(style.warn('Could not reach the control plane.'));
    flow.hint('The rules on disk still apply, and the next pass tries again.');
    return;
  }
  if (pass.pull !== undefined) renderPull(context, pass.pull);
  if (pass.push !== undefined) renderPush(context, pass.push);
  if (pass.census !== undefined) renderCensus(context, pass.census);
  flow.close('One pass done.');
}

/** Said only when there was something to say: most passes have no new scan. */
function renderCensus(context: CliContext, result: PushResult): void {
  const { flow, style } = context;
  if (result.outcome === PUSH_OUTCOME.SENT) {
    flow.step('Census', `sent what ${result.sent} of this machine's capabilities are`);
    return;
  }
  if (result.outcome === PUSH_OUTCOME.REFUSED) {
    flow.step(
      style.warn('The control plane would not take the scan'),
      `${result.because ?? 'no reason given'}, so it stays on this machine`,
    );
  }
}

function renderPull(context: CliContext, result: PullResult): void {
  const { flow, style } = context;
  switch (result.outcome) {
    case PULL_OUTCOME.UNCHANGED:
      flow.step('Rules', 'already up to date');
      return;
    case PULL_OUTCOME.APPLIED:
      flow.rows('Rules pulled', [
        { label: 'rules', value: String(result.rules) },
        { label: 'conditions', value: String(result.conditions) },
        // Omitted rather than empty, because an empty row reads as a bundle with no hash.
        ...(result.hash === undefined ? [] : [{ label: 'bundle', value: result.hash }]),
      ]);
      return;
    case PULL_OUTCOME.REFUSED:
      flow.step(
        style.warn('That bundle would not load, so the previous one still applies'),
        result.because ?? 'no reason given',
      );
      return;
    case PULL_OUTCOME.REVOKED:
      flow.step(
        style.warn('This machine has been revoked'),
        'the rules it already pulled still apply',
      );
      flow.aside('Run "memnox login" to enrol again.');
      return;
    case PULL_OUTCOME.LAPSED:
      flow.step(
        style.warn('The subscription has lapsed, so the rules are frozen as they are'),
        'nothing has been loosened; this machine enforces what it last agreed to',
      );
      return;
  }
}

function renderPush(context: CliContext, result: PushResult): void {
  const { flow, style } = context;
  switch (result.outcome) {
    case PUSH_OUTCOME.NOTHING:
      flow.step('Sent', 'nothing new to send');
      return;
    case PUSH_OUTCOME.SENT:
      flow.step(
        'Sent',
        `${result.sent} action(s)${
          result.duplicates === 0 ? '' : `, ${result.duplicates} already known`
        }`,
      );
      return;
    case PUSH_OUTCOME.REVOKED:
      flow.step(style.warn('This machine has been revoked'), 'so nothing was sent');
      return;
    case PUSH_OUTCOME.REFUSED:
      flow.step(
        style.warn('The control plane would not take that batch'),
        `${result.because ?? 'no reason given'}, so it stays on this machine`,
      );
      return;
  }
}
