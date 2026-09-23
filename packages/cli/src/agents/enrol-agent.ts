import { HTTP, isCredentialRefused, isRouteMissing, type Account } from '@memnox/core';

import { openBrowser } from '../sync/browser';
import { callCloud } from '../sync/client';
import {
  approvalUrl,
  goodFor,
  machineKeypair,
  pageCarriesCode,
  requestCode,
  waitForApproval,
  type DeviceOffer,
} from '../sync/enrol';

/**
 * An agent, enrolled as an advisory principal of its own on the credential this machine
 * already holds, because five browser approvals is a run that ends half finished. The
 * device flow stays as the fallback for a control plane older than that route.
 */

export interface EnrolledAgent {
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
 * The one thing enrolment has to say, which is that it is waiting on a person. Injected
 * because the callers draw different screens; success is theirs to render.
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

export interface EnrolAgentInput {
  sponsor: Sponsor;
  agentId: string;
  hostname: string;
  report: EnrolReporter;
  /** What to call it on screen. The id stays the identity the credential is cut for. */
  shownAs: string;
  /** What product it is: the control plane hashes the hostname, so this and the id are all it can read. */
  agentKind?: string;
}

export async function enrolAgent(
  input: EnrolAgentInput,
): Promise<EnrolledAgent | EnrolFailure> {
  const sponsored = await enrolOnThisMachine(input);
  if ('machineId' in sponsored) return sponsored;
  if (sponsored.outcome === ENROL_FAILED) return sponsored;
  // A missing route or a refused credential, and the reason travels so a browser opening is explained.
  return askAPerson(input, sponsored.because);
}

/** The sponsored door did not answer, and why that is not yet a failure. */
const FALL_BACK = 'fall_back';

interface FallBack {
  outcome: typeof FALL_BACK;
  because: string;
}

function failureOf(err: unknown): EnrolFailure {
  return {
    outcome: ENROL_FAILED,
    because: err instanceof Error ? err.message : String(err),
  };
}

/** The product, where it is known, in the shape both doors take. */
function kindField(agentKind: string | undefined): { agentKind?: string } {
  return agentKind === undefined ? {} : { agentKind };
}

/** The credential this machine already holds, spent on the agents it hosts. */
async function enrolOnThisMachine(
  input: EnrolAgentInput,
): Promise<EnrolledAgent | FallBack | EnrolFailure> {
  const { sponsor } = input;
  // Unreachable is reported rather than fallen back from, since a browser cannot reach it either.
  const answer = await callCloud<EnrolledPrincipal>({
    baseUrl: sponsor.baseUrl,
    path: `/v1/workspaces/${encodeURIComponent(sponsor.workspaceId)}/machines/${encodeURIComponent(sponsor.machineId)}/agents`,
    method: 'POST',
    token: sponsor.token,
    body: { agentId: input.agentId, label: input.shownAs, ...kindField(input.agentKind) },
  }).catch(failureOf);
  if ('outcome' in answer) return answer;
  return readSponsoredAnswer(answer);
}

/**
 * 404 and 405 mean a control plane older than the route, 401 and 403 a revoked laptop:
 * a person in a browser still answers both. Anything else is a refusal.
 */
function readSponsoredAnswer(answer: {
  status: number;
  body?: EnrolledPrincipal;
}): EnrolledAgent | FallBack | EnrolFailure {
  if (isRouteMissing(answer.status)) {
    return {
      outcome: FALL_BACK,
      because: 'this control plane cannot enrol an agent without a person',
    };
  }
  if (isCredentialRefused(answer.status)) {
    return { outcome: FALL_BACK, because: "this machine's own credential was refused" };
  }
  if (answer.status !== HTTP.OK && answer.status !== HTTP.CREATED) {
    return { outcome: ENROL_FAILED, because: refusalOf(answer) };
  }
  const body = answer.body;
  if (body?.id === undefined || body.token === undefined) {
    return { outcome: ENROL_FAILED, because: 'the control plane sent no credential' };
  }
  // The credential is readable once, so a reply with no address is not half written into a config.
  if (body.mcpUrl === undefined) {
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
 * The device flow, for a control plane that has no other door. The link carries the
 * code, so a browser is the whole step and the code is printed only where none opened.
 */
async function askAPerson(
  input: EnrolAgentInput,
  because: string,
): Promise<EnrolledAgent | EnrolFailure> {
  const baseUrl = input.sponsor.baseUrl;
  try {
    const offer = await requestAgentCode(input);
    const url = approvalUrl(baseUrl, offer.userCode, offer);
    const opened = await openBrowser(url);
    input.report.approve({
      what: input.shownAs,
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
    const { machineId, token, mcpUrl } = collected;
    return { machineId, token, mcpUrl, approvedInBrowser: true };
  } catch (err) {
    return failureOf(err);
  }
}

function requestAgentCode(input: EnrolAgentInput): Promise<DeviceOffer> {
  // Generated and not sent, since an advisory principal signs nothing, to keep one path through requestCode.
  const { publicKey } = machineKeypair();
  return requestCode(
    {
      baseUrl: input.sponsor.baseUrl,
      host: `${input.agentId}@${input.hostname}`,
      // The name travels because the control plane hashes the hostname above.
      label: input.shownAs,
      agentId: input.agentId,
      ...kindField(input.agentKind),
      connection: 'mcp',
    },
    publicKey,
  );
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
    return answer.status === HTTP.OK || answer.status === HTTP.NO_CONTENT;
  } catch {
    return false;
  }
}
