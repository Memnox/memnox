import { generateKeyPairSync } from 'node:crypto';
import { hostname } from 'node:os';
import { CLI_VERSION } from '../defaults';
import { callCloud, CloudUnreachable } from './client';
import type { Account } from './account';

/**
 * Enrolling this machine, the way `npm login` signs you in: the CLI asks, prints
 * a code and a URL, you approve in a browser, and it polls until you have.
 *
 * A laptop could use a loopback redirect instead, and the control plane offers
 * one. This flow is used for both because it is the only one that also works on
 * the machines that have no browser to redirect — a CI runner, a container, a
 * server over SSH — and two ways to enrol is one of them nobody tests.
 */

interface DeviceOffer {
  deviceCode: string;
  userCode: string;
  intervalSeconds: number;
  expiresAt: number;
}

interface Collected {
  machineId: string;
  token: string;
  mode: string;
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
  workspaceId: string;
  /** Sent once so a person can see which machine they are approving. */
  host?: string;
  mode?: string;
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
    body: {
      workspaceId: options.workspaceId,
      hostname: options.host ?? hostname(),
      publicKey,
      runtimeVersion: CLI_VERSION,
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    },
  });
  if (answer.status !== 200 && answer.status !== 201) {
    throw new EnrolmentRefused(
      `the control plane refused the request (${answer.status}). Check the workspace id.`,
    );
  }
  const offer = answer.body;
  if (offer === undefined) {
    throw new EnrolmentRefused('the control plane sent no code.');
  }
  return offer;
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

  if (answer.status === 200 && answer.body !== undefined) {
    return answer.body;
  }
  const error = answer.body?.error;
  if (error === PENDING || answer.status === 400) return null;

  throw new EnrolmentRefused(
    error === 'access_denied'
      ? ENROL_REFUSAL.DENIED
      : error === 'expired_token'
        ? ENROL_REFUSAL.EXPIRED
        : ENROL_REFUSAL.UNKNOWN,
  );
}

export interface WaitSeams {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
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
  const sleep = seams.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = seams.now ?? Date.now;

  while (now() < offer.expiresAt) {
    const collected = await collect(baseUrl, offer.deviceCode);
    if (collected !== null) return collected;
    await sleep(offer.intervalSeconds * 1000);
  }
  throw new EnrolmentRefused(ENROL_REFUSAL.EXPIRED);
}

/** Where a person goes to approve, printed for them to open. */
export function approvalUrl(baseUrl: string, userCode: string): string {
  return new URL(`/device?code=${encodeURIComponent(userCode)}`, baseUrl).toString();
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
    workspaceId: options.workspaceId,
    machineId: collected.machineId,
    token: collected.token,
    privateKey: keys.privateKey,
    enrolledAt: at,
  };
}

export { CloudUnreachable };
