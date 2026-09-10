import type { CliOutput } from '../cli-output';
import { approvalUrl, machineKeypair, requestCode, waitForApproval } from '../sync/enrol';

/**
 * An agent, enrolled as an advisory principal of its own.
 *
 * Through the device flow, and that is not a detail. `POST :ws/machines` is
 * admin-only and carries no `@MachineRoute`, so the credential this machine
 * already holds cannot mint another: a machine that could enrol machines could
 * enrol as many as it liked, and enrolment is exactly the act the control plane
 * requires a person for. So onboarding an agent shows a code and waits for
 * somebody to approve it, the same way `memnox login` does for the host.
 *
 * That is the right shape rather than an obstacle. Nothing promotes itself
 * here either: an agent joins because a person said so, and the approval screen
 * names it as advisory so nobody mistakes a cooperating agent for a gated one.
 *
 * One enrolment per agent rather than per host, so revoking one agent's access
 * does not take the others on that laptop with it.
 */

interface EnrolledAgent {
  machineId: string;
  token: string;
  mcpUrl: string;
}

export const ENROL_FAILED = 'enrol_failed';

interface EnrolFailure {
  outcome: typeof ENROL_FAILED;
  because: string;
}

export async function enrolAgent(
  baseUrl: string,
  agentId: string,
  hostname: string,
  out: CliOutput,
): Promise<EnrolledAgent | EnrolFailure> {
  try {
    /* A key is generated and then not sent: an advisory principal signs no
       batches, so the door refuses a public key from one. Generating it anyway
       keeps one path through `requestCode` rather than two. */
    const { publicKey } = machineKeypair();
    const offer = await requestCode(
      { baseUrl, host: `${agentId}@${hostname}`, connection: 'mcp' },
      publicKey,
    );

    out.line(`Approve ${agentId} with the code ${offer.userCode}`);
    out.note(approvalUrl(baseUrl, offer.userCode, offer));

    const collected = await waitForApproval(baseUrl, offer);
    if (collected.mcpUrl === undefined) {
      /* The credential is readable once. A reply with no address to use it
         against is not one to write half of into somebody's config. */
      return {
        outcome: ENROL_FAILED,
        because: 'the control plane approved it but returned no MCP address',
      };
    }
    return {
      machineId: collected.machineId,
      token: collected.token,
      mcpUrl: collected.mcpUrl,
    };
  } catch (err) {
    return {
      outcome: ENROL_FAILED,
      because: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Best effort: a config already restored must not fail over a revocation. */
export async function revokeAgent(
  account: { baseUrl: string; workspaceId: string; token: string },
  machineId: string,
): Promise<boolean> {
  const { callCloud } = await import('../sync/client');
  try {
    const answer = await callCloud({
      baseUrl: account.baseUrl,
      path: `/v1/workspaces/${account.workspaceId}/machines/${encodeURIComponent(machineId)}`,
      method: 'DELETE',
      token: account.token,
    });
    return answer.status === 200 || answer.status === 204;
  } catch {
    return false;
  }
}
