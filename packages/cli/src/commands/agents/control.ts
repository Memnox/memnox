/** `memnox agents control`: collect what an operator has said to the agents here. */
import { readAccount, type Account } from '@memnox/core';
import { CONTROL_OUTCOME, drainControl, type ControlCommand } from '../../sync/control';
import { deliver, resolveAddressed, type AgentsDeps, type JsonOptions } from './shared';

interface Collected {
  commands: ControlCommand[];
  revoked: boolean;
}

/** Collect what an operator has said to the agents here, and hand it over. */
export async function runControl(
  deps: AgentsDeps,
  agent: string | undefined,
  options: JsonOptions,
): Promise<void> {
  const { context, home } = deps;
  const { flow, style } = context;
  const asJson = options.json === true;
  if (!asJson) flow.open('memnox agents control');

  const account = await readAccount(home());
  const collected: Collected =
    account === null
      ? { commands: [], revoked: false }
      : await drainEach(account, await resolveAddressed(deps, agent));

  if (asJson) {
    context.out.json(collected);
    return;
  }
  if (account === null) {
    flow.close('Not logged in, so nobody can have said anything.');
    flow.hint('Connect this machine with "memnox login".');
    return;
  }
  if (collected.revoked) {
    flow.close(style.warn('This machine has been revoked.'));
    flow.hint('Run "memnox login" to enrol it again.');
    return;
  }
  if (collected.commands.length === 0) {
    flow.close('Nothing has been said to the agents on this machine.');
    return;
  }
  await deliver(context, account, collected.commands);
}

/** Drains each agent in turn, stopping at the first sign this machine was revoked. */
async function drainEach(
  account: Account,
  agentIds: readonly string[],
): Promise<Collected> {
  const commands: ControlCommand[] = [];
  for (const agentId of agentIds) {
    const result = await drainControl(account, agentId);
    if (result.outcome === CONTROL_OUTCOME.REVOKED) return { commands, revoked: true };
    commands.push(...result.commands);
  }
  return { commands, revoked: false };
}
