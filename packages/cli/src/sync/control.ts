import { HTTP, isCredentialRefused, type Account } from '@memnox/core';

import { callCloud, type CloudResponse } from './client';

/**
 * What an operator said to an agent here, collected on our own move. A command carries
 * words and is never a verdict, or the gate would move onto the network.
 */

export const CONTROL_OUTCOME = {
  /** Turns were waiting and are now in hand. */
  COLLECTED: 'collected',
  /** Nobody has said anything. The ordinary case, and not worth a line. */
  NOTHING: 'nothing',
  /** The credential is gone: revoked here, or this machine was removed. */
  REVOKED: 'revoked',
  /** The control plane answered and refused. Its words, not ours. */
  REFUSED: 'refused',
} as const;

type ControlOutcome = (typeof CONTROL_OUTCOME)[keyof typeof CONTROL_OUTCOME];

/** One operator turn, as the control plane stores it. */
export interface ControlCommand {
  id: string;
  agentId: string;
  message: string;
  issuedBy: string;
  issuedAt: string;
  status: string;
}

interface ControlResult {
  outcome: ControlOutcome;
  commands: ControlCommand[];
  because?: string;
}

interface DrainBody {
  commands?: ControlCommand[];
}

/**
 * Collect what is waiting for one agent. A turn is handed over once, so it is already
 * delivered, and returned rather than printed because only the caller knows who sees it.
 */
export async function drainControl(
  account: Account,
  agentId: string,
): Promise<ControlResult> {
  let answer: CloudResponse<DrainBody>;
  try {
    answer = await callCloud<DrainBody>({
      baseUrl: account.baseUrl,
      path: `${agentControlPath(account, agentId)}/drain`,
      method: 'POST',
      token: account.token,
      body: {},
    });
  } catch (error) {
    // Unreachable is not refused: nothing could be said, which is nothing said.
    return {
      outcome: CONTROL_OUTCOME.NOTHING,
      commands: [],
      because: error instanceof Error ? error.message : 'unreachable',
    };
  }
  return controlResultOf(answer);
}

function controlResultOf(answer: CloudResponse<DrainBody>): ControlResult {
  if (isCredentialRefused(answer.status)) {
    return { outcome: CONTROL_OUTCOME.REVOKED, commands: [] };
  }
  if (answer.status !== HTTP.OK) {
    return {
      outcome: CONTROL_OUTCOME.REFUSED,
      commands: [],
      because: `the control plane answered ${answer.status}`,
    };
  }

  const commands = answer.body?.commands;
  if (commands === undefined || commands.length === 0) {
    return { outcome: CONTROL_OUTCOME.NOTHING, commands: [] };
  }
  return { outcome: CONTROL_OUTCOME.COLLECTED, commands };
}

/**
 * Say what became of one turn, best effort: the turn is already delivered, so failing
 * the command over a lost receipt would give up the half that worked.
 */
export async function acknowledgeControl(
  account: Account,
  agentId: string,
  commandId: string,
  outcome: { ok: boolean; error?: string },
): Promise<boolean> {
  try {
    const answer = await callCloud({
      baseUrl: account.baseUrl,
      path: `${agentControlPath(account, agentId)}/commands/${encodeURIComponent(commandId)}/ack`,
      method: 'POST',
      token: account.token,
      body: outcome.error === undefined ? { ok: outcome.ok } : outcome,
    });
    return answer.status === HTTP.OK;
  } catch {
    // See above: a lost receipt is not a lost message.
    return false;
  }
}

function agentControlPath(account: Account, agentId: string): string {
  return `/v1/workspaces/${account.workspaceId}/agents/${encodeURIComponent(agentId)}/control`;
}
