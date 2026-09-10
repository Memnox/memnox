import type { Account } from '@memnox/core';
import { callCloud } from './client';

/**
 * What an operator said to an agent on this machine, collected on our own move.
 *
 * The seam still runs one way. Nothing dials this machine: it asks, exactly as
 * it asks for a bundle and exactly as it reports what it did. A control plane
 * that could open a connection to a laptop would be the thing `VISION.md`
 * section 25 says this product must never need.
 *
 * **A command is not a verdict, and this module must never treat one as one.**
 * It carries a person's words to whoever is at the agent, and what the agent
 * then does is decided here, locally, against the bundle already on disk. If a
 * message ever starts being read as permission, the gate has been moved onto
 * the network and the whole local-first claim goes with it.
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
 * Collect what is waiting for one agent.
 *
 * The control plane hands a turn over once, so anything returned here has been
 * marked delivered and will not come again. That is why this returns them
 * rather than printing them: losing them after they are in hand is losing them
 * for good, and the caller is the only thing that knows whether they landed
 * somewhere a person will see.
 */
export async function drainControl(
  account: Account,
  agentId: string,
): Promise<ControlResult> {
  let answer;
  try {
    answer = await callCloud<DrainBody>({
      baseUrl: account.baseUrl,
      path: `/v1/workspaces/${account.workspaceId}/agents/${encodeURIComponent(
        agentId,
      )}/control/drain`,
      method: 'POST',
      token: account.token,
      body: {},
    });
  } catch (error) {
    /* Unreachable is not refused. A machine that cannot reach its control plane
       has nothing said to it, which is the same as nothing being said. */
    return {
      outcome: CONTROL_OUTCOME.NOTHING,
      commands: [],
      because: error instanceof Error ? error.message : 'unreachable',
    };
  }

  if (answer.status === 401 || answer.status === 403) {
    return { outcome: CONTROL_OUTCOME.REVOKED, commands: [] };
  }
  if (answer.status !== 200) {
    return {
      outcome: CONTROL_OUTCOME.REFUSED,
      commands: [],
      because: `the control plane answered ${answer.status}`,
    };
  }

  const body = answer.body;
  const commands = body === undefined ? undefined : body.commands;
  if (commands === undefined || commands.length === 0) {
    return { outcome: CONTROL_OUTCOME.NOTHING, commands: [] };
  }
  return { outcome: CONTROL_OUTCOME.COLLECTED, commands };
}

/**
 * Say what became of one turn.
 *
 * Best effort, and deliberately so. The turn has already been delivered and
 * whoever was at the agent has already seen it; failing the command because the
 * receipt did not land would be losing the thing that worked over the thing
 * that did not.
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
      path: `/v1/workspaces/${account.workspaceId}/agents/${encodeURIComponent(
        agentId,
      )}/control/commands/${encodeURIComponent(commandId)}/ack`,
      method: 'POST',
      token: account.token,
      body: outcome.error === undefined ? { ok: outcome.ok } : outcome,
    });
    return answer.status === 200;
  } catch {
    // See above: a lost receipt is not a lost message.
    return false;
  }
}
