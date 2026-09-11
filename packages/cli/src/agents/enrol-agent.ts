import type { Account } from '@memnox/core';
import { callCloud } from '../sync/client';
import { openBrowser } from '../sync/browser';
import {
  approvalUrl,
  goodFor,
  machineKeypair,
  pageCarriesCode,
  requestCode,
  waitForApproval,
} from '../sync/enrol';

/**
 * An agent, enrolled as an advisory principal of its own.
 *
 * **On the credential this machine already holds, wherever the control plane
 * will take it.** A person approved this laptop once, in a browser, and every
 * agent on it is a thing that laptop hosts. Asking them to approve again per
 * agent was the same decision put five times, and the fifth answer is the one
 * somebody never gives: a run that opens five browser tabs is a run that ends
 * half finished, with two agents governed and three believed to be.
 * `POST :ws/machines/:id/agents` is the door, and the guard pins a machine
 * credential to its own `:id`, so what this can enrol is the agents on the box
 * that was approved and nothing anywhere else.
 *
 * The device flow is still here and still the fallback, because a control plane
 * older than that route answers 404 and somebody upgrading their laptop before
 * their cloud must not be stopped. It is also what runs when the machine has no
 * credential at all. One path tried, one path behind it, and the screen says
 * which happened rather than leaving a browser to explain itself.
 *
 * One enrolment per agent rather than per host, so revoking one agent's access
 * does not take the others on that laptop with it. The row remembers which
 * machine vouched for it, so revoking the laptop still takes them all.
 */

interface EnrolledAgent {
  machineId: string;
  token: string;
  mcpUrl: string;
  /** Whether a person had to answer a browser for this one. */
  approvedInBrowser: boolean;
}

export const ENROL_FAILED = 'enrol_failed';

interface EnrolFailure {
  outcome: typeof ENROL_FAILED;
  because: string;
}

/**
 * The one thing enrolment has to say, which is that it is waiting on a person.
 *
 * Injected because the two callers draw different screens: the guided run has a
 * rail down the left and `agents onboard` prints plain lines. Printing through
 * `console.log` here put the one step that can block forever outside whatever
 * was drawing the rest of the run, which is how a wait reads as a hang.
 *
 * Nothing reports success. A caller that got a credential back knows it did,
 * and says so in its own shape rather than being narrated at.
 */
export interface EnrolReporter {
  approve(question: Approval): void;
}

export interface Approval {
  /** The agent, by the name the person just gave it. */
  what: string;
  url: string;
  /** Printed only where a browser could not be opened, or the link carries none. */
  code?: string;
  /** Why a browser is involved at all, when the run promised it would not be. */
  because: string;
  /** How long they have, so a silent wait has an end named on it. */
  deadline: string;
}

/** What a machine credential is asked for, which is less than a whole account. */
interface Sponsor {
  baseUrl: string;
  workspaceId: string;
  machineId: string;
  token: string;
}

export function sponsorOf(account: Account): Sponsor {
  return {
    baseUrl: account.baseUrl,
    workspaceId: account.workspaceId,
    machineId: account.machineId,
    token: account.token,
  };
}

export async function enrolAgent(
  sponsor: Sponsor,
  agentId: string,
  hostname: string,
  report: EnrolReporter,
  /** What to call it on screen. The id stays the identity the credential is cut for. */
  shownAs: string = agentId,
): Promise<EnrolledAgent | EnrolFailure> {
  const sponsored = await enrolOnThisMachine(sponsor, agentId, shownAs);
  if ('machineId' in sponsored) return sponsored;
  if (sponsored.outcome === ENROL_FAILED) return sponsored;

  /* Only two things land here: a control plane with no such route, or one that
     would not take this machine's credential. The reason travels to the screen,
     because a browser opening after a run that said it would not open one is
     the kind of surprise people read as a bug. */
  return askAPerson(
    sponsor.baseUrl,
    agentId,
    hostname,
    report,
    shownAs,
    sponsored.because,
  );
}

/** The sponsored door did not answer, and why that is not yet a failure. */
const FALL_BACK = 'fall_back';

interface FallBack {
  outcome: typeof FALL_BACK;
  because: string;
}

/**
 * The credential this machine already holds, spent on the agents it hosts.
 *
 * A 404 or a 405 is a control plane older than the route, and a 401 or a 403 is
 * one that will not take this machine's credential, which is a revoked laptop or
 * a hand-edited `account.json`. Both are cases where a person in a browser is
 * still a true answer, so both fall back rather than fail. Anything else is a
 * refusal with a reason, and a refusal is reported rather than worked around.
 */
async function enrolOnThisMachine(
  sponsor: Sponsor,
  agentId: string,
  shownAs: string,
): Promise<EnrolledAgent | FallBack | EnrolFailure> {
  let answer: Awaited<ReturnType<typeof callCloud<EnrolledPrincipal>>>;
  try {
    answer = await callCloud<EnrolledPrincipal>({
      baseUrl: sponsor.baseUrl,
      path: `/v1/workspaces/${encodeURIComponent(sponsor.workspaceId)}/machines/${encodeURIComponent(sponsor.machineId)}/agents`,
      method: 'POST',
      token: sponsor.token,
      body: { agentId, label: shownAs },
    });
  } catch (err) {
    /* Unreachable is not "this control plane cannot do it", and a browser
       cannot reach it either. Reported rather than fallen back from. */
    return {
      outcome: ENROL_FAILED,
      because: err instanceof Error ? err.message : String(err),
    };
  }

  if (answer.status === 404 || answer.status === 405 || answer.status === 501) {
    return {
      outcome: FALL_BACK,
      because: 'this control plane cannot enrol an agent without a person',
    };
  }
  if (answer.status === 401 || answer.status === 403) {
    return {
      outcome: FALL_BACK,
      because: "this machine's own credential was refused",
    };
  }
  if (answer.status !== 200 && answer.status !== 201) {
    return { outcome: ENROL_FAILED, because: refusalOf(answer) };
  }

  const body = answer.body;
  if (body?.id === undefined || body.token === undefined) {
    return { outcome: ENROL_FAILED, because: 'the control plane sent no credential' };
  }
  if (body.mcpUrl === undefined) {
    /* The credential is readable once. A reply with no address to use it
       against is not one to write half of into somebody's config. */
    return {
      outcome: ENROL_FAILED,
      because: 'the control plane enrolled it but returned no MCP address',
    };
  }
  return {
    machineId: body.id,
    token: body.token,
    mcpUrl: body.mcpUrl,
    approvedInBrowser: false,
  };
}

/** What the door sends back, read defensively: every field is somebody else's. */
interface EnrolledPrincipal {
  id?: string;
  token?: string;
  mcpUrl?: string;
}

/** The sentence the control plane sent, or the status if it sent none. */
function refusalOf(answer: { status: number; body?: unknown }): string {
  // Nest words its refusals in `message`; anything else falls through to the status.
  const said = (answer.body as { message?: unknown } | undefined)?.message;
  if (typeof said === 'string' && said !== '') return said;
  return `the control plane refused the request (${answer.status})`;
}

/**
 * The device flow, for a control plane that has no other door.
 *
 * Unchanged in shape from when it was the only path: the link carries the code,
 * so a browser is the whole step, and the code is printed only where one could
 * not be opened.
 */
async function askAPerson(
  baseUrl: string,
  agentId: string,
  hostname: string,
  report: EnrolReporter,
  shownAs: string,
  because: string,
): Promise<EnrolledAgent | EnrolFailure> {
  try {
    /* A key is generated and then not sent: an advisory principal signs no
       batches, so the door refuses a public key from one. Generating it anyway
       keeps one path through `requestCode` rather than two. */
    const { publicKey } = machineKeypair();
    const offer = await requestCode(
      {
        baseUrl,
        host: `${agentId}@${hostname}`,
        /* The name travels, because the hostname above does not: the control
           plane hashes it. Without this the console shows a hex id and the
           name a person just chose lives only on their laptop. */
        label: shownAs,
        connection: 'mcp',
      },
      publicKey,
    );

    const url = approvalUrl(baseUrl, offer.userCode, offer);
    const opened = await openBrowser(url);
    report.approve({
      what: shownAs,
      url,
      because,
      deadline: goodFor(offer),
      ...(opened && pageCarriesCode(offer) ? {} : { code: offer.userCode }),
    });

    const collected = await waitForApproval(baseUrl, offer);
    if (collected.mcpUrl === undefined) {
      return {
        outcome: ENROL_FAILED,
        because: 'the control plane approved it but returned no MCP address',
      };
    }
    return {
      machineId: collected.machineId,
      token: collected.token,
      mcpUrl: collected.mcpUrl,
      approvedInBrowser: true,
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
