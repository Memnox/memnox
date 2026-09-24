import { generateKeyPairSync } from 'node:crypto';
import { hostname } from 'node:os';

import {
  HTTP,
  isEnforcementMode,
  msToMinutes,
  secondsToMs,
  type Account,
} from '@memnox/core';

import { CLI_VERSION } from '../defaults';
import { callCloud, CloudUnreachable } from './client';

/**
 * Enrolling this machine: ask, open the approval page with the code in its link, and poll
 * until somebody answers. The code stays printable for a server over SSH, in the same flow.
 */

export interface DeviceOffer {
  deviceCode: string;
  userCode: string;
  intervalSeconds: number;
  expiresAt: number;
  /** Where a person approves this, and the same page with the code in it; older planes send neither. */
  verificationUri?: string;
  verificationUriComplete?: string;
}

export interface Collected {
  machineId: string;
  token: string;
  mode: string;
  /** Where it landed. Decided by whoever approved, not asked for here. */
  workspaceId: string;
  /** Where an advisory principal talks to, present when it enrolled as one. */
  mcpUrl?: string;
}

/** What the control plane says while nobody has answered yet. */
const PENDING = 'authorization_pending';

const ENROL_REFUSAL = {
  DENIED: 'the request was refused in the browser',
  EXPIRED: 'the code expired before anybody approved it',
  UNKNOWN: 'the control plane does not know that code',
} as const;

export class EnrolmentRefused extends Error {}

interface EnrolOptions {
  baseUrl: string;
  /** Sent once so a person can see which machine they are approving. */
  host?: string;
  /** What the console shows, because the control plane hashes the hostname and keeps only this. */
  label?: string;
  /** The agent this credential is for, where it is for one, so a typed name has a product. */
  agentId?: string;
  agentKind?: string;
  mode?: string;
  /** `mcp` for an advisory principal, shown on the approval screen as cooperation rather than interposition. */
  connection?: string;
}

/** Ed25519, generated here. The private half never leaves this process. */
export function machineKeypair(): { publicKey: string; privateKey: string } {
  const pair = generateKeyPairSync('ed25519');
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export async function requestCode(
  options: EnrolOptions,
  publicKey: string,
): Promise<DeviceOffer> {
  const answer = await callCloud<DeviceOffer>({
    baseUrl: options.baseUrl,
    path: '/v1/device/codes',
    method: 'POST',
    body: codeRequestBody(options, publicKey),
  });
  if (answer.status !== HTTP.OK && answer.status !== HTTP.CREATED) {
    throw new EnrolmentRefused(describeCodeRefusal(options.baseUrl, answer.status));
  }
  const offer = answer.body;
  if (offer === undefined) {
    throw new EnrolmentRefused('the control plane sent no code.');
  }
  return offer;
}

function codeRequestBody(
  options: EnrolOptions,
  publicKey: string,
): Record<string, unknown> {
  return {
    hostname: options.host ?? hostname(),
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
    ...(options.agentKind === undefined ? {} : { agentKind: options.agentKind }),
    // Omitted for an advisory principal, which signs no bytes there is a key to check.
    ...(options.connection === 'mcp' ? {} : { publicKey }),
    runtimeVersion: CLI_VERSION,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.connection === undefined ? {} : { connection: options.connection }),
  };
}

/** A 404 is a host that does not serve this API, which is not a refusal to argue with. */
function describeCodeRefusal(baseUrl: string, status: number): string {
  const missing = status === HTTP.NOT_FOUND || status === HTTP.NOT_IMPLEMENTED;
  if (!missing) return `the control plane refused the request (${status}).`;
  return (
    `${baseUrl} has no device-enrolment endpoint (${status}), so it is not a Memnox control plane.\n` +
    'Point at the right one with "memnox login --url <base>". This machine is unchanged.'
  );
}

/** The refusal each error word the token door sends stands for. */
function refusalOf(error: string | undefined): string {
  if (error === 'access_denied') return ENROL_REFUSAL.DENIED;
  if (error === 'expired_token') return ENROL_REFUSAL.EXPIRED;
  return ENROL_REFUSAL.UNKNOWN;
}

/**
 * One poll. Separated from the waiting so a test drives it without a clock, and
 * so the caller owns the interval it was told to use rather than inventing one.
 */
async function collect(baseUrl: string, deviceCode: string): Promise<Collected | null> {
  const answer = await callCloud<Collected & { error?: string }>({
    baseUrl,
    path: '/v1/device/tokens',
    method: 'POST',
    body: { deviceCode },
  });

  if (answer.status === HTTP.OK && answer.body !== undefined) {
    return answer.body;
  }
  const error = answer.body?.error;
  if (error === PENDING || answer.status === HTTP.BAD_REQUEST) return null;

  throw new EnrolmentRefused(refusalOf(error));
}

export interface WaitSeams {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * How long to leave between polls, whatever the control plane asked for: a zero would
 * poll as fast as the network answers, and the ceiling keeps an approval from waiting.
 */
const POLL_FLOOR_MS = secondsToMs(1);
const POLL_CEILING_MS = secondsToMs(30);

function pollEvery(offer: DeviceOffer): number {
  const asked = secondsToMs(offer.intervalSeconds);
  if (!Number.isFinite(asked)) return POLL_FLOOR_MS;
  return Math.min(Math.max(asked, POLL_FLOOR_MS), POLL_CEILING_MS);
}

/** How long a person has to answer, in the words a screen says it in. */
export function goodFor(offer: DeviceOffer, now: number = Date.now()): string {
  const minutes = msToMinutes(offer.expiresAt - now);
  if (minutes <= 1) return 'about a minute';
  return `${minutes} minutes`;
}

/**
 * Polls until somebody answers or the code runs out. Never faster than the
 * interval the control plane asked for: a CLI that polls harder than it was
 * told is one a rate limiter eventually stops answering.
 */
export async function waitForApproval(
  baseUrl: string,
  offer: DeviceOffer,
  seams: WaitSeams = {},
): Promise<Collected> {
  const sleep =
    seams.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const now = seams.now ?? Date.now;
  const every = pollEvery(offer);

  while (now() < offer.expiresAt) {
    const collected = await collect(baseUrl, offer.deviceCode);
    if (collected !== null) return collected;
    await sleep(every);
  }
  throw new EnrolmentRefused(ENROL_REFUSAL.EXPIRED);
}

/**
 * Where to send somebody to approve this machine. The control plane's own answer wins,
 * because the base URL is an API serving no pages; derived only for one too old to say.
 */
export function approvalUrl(
  baseUrl: string,
  userCode: string,
  offered?: { verificationUri?: string; verificationUriComplete?: string },
): string {
  const said = offered?.verificationUriComplete ?? offered?.verificationUri;
  if (said !== undefined && said !== '') return said;
  return new URL(`/device?code=${encodeURIComponent(userCode)}`, baseUrl).toString();
}

/**
 * Whether that address carries the code already, which is what makes opening a browser
 * enough on its own. Where it does not, the code is worth the space on screen.
 */
export function pageCarriesCode(offered?: { verificationUriComplete?: string }): boolean {
  const complete = offered?.verificationUriComplete;
  return complete !== undefined && complete !== '';
}

export function accountFrom(
  options: EnrolOptions,
  keys: { privateKey: string },
  collected: Collected,
  at: string,
): Account {
  return {
    version: 1,
    baseUrl: options.baseUrl,
    workspaceId: collected.workspaceId,
    machineId: collected.machineId,
    token: collected.token,
    privateKey: keys.privateKey,
    enrolledAt: at,
    // Recorded as heard rather than applied, or the first heartbeat would rewrite `config.toml`.
    ...(isEnforcementMode(collected.mode) ? { cloudMode: collected.mode } : {}),
  };
}

export { CloudUnreachable };
