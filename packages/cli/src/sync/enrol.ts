import { generateKeyPairSync } from 'node:crypto';
import { hostname } from 'node:os';
import { CLI_VERSION } from '../defaults';
import { callCloud, CloudUnreachable } from './client';
import { isEnforcementMode, type Account } from '@memnox/core';

/**
 * Enrolling this machine, the way `npm login` signs you in: the CLI asks, opens
 * the approval page in a browser, and polls until somebody has answered it.
 *
 * The link the control plane sends carries the code, so on a laptop nobody ever
 * reads eight characters off one screen to type into another. The code is still
 * what this is underneath, because that is the half that works on the machines
 * with no browser to open, which is a CI runner, a container or a server over
 * SSH. One flow with the browser step skipped rather than two flows, because two
 * is one of them nobody tests.
 */

interface DeviceOffer {
  deviceCode: string;
  userCode: string;
  intervalSeconds: number;
  expiresAt: number;
  /**
   * Where the control plane says a person approves this, and the same page with
   * the code already in it. Optional because a deployment with no console
   * configured sends neither, and because a control plane older than this field
   * sends neither either.
   */
  verificationUri?: string;
  verificationUriComplete?: string;
}

interface Collected {
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
  /**
   * What a person calls this, and what the console shows afterwards.
   *
   * The control plane hashes the hostname and never stores it, so without this
   * an enrolment reaches the fleet listing as a hex id. That was tolerable while
   * the only thing enrolling was a laptop the same person was sitting at; an
   * onboarded agent is a thing somebody deliberately named, and dropping the
   * name here would mean asking for it and then throwing it away.
   */
  label?: string;
  mode?: string;
  /**
   * `mcp` for an agent enrolled as an advisory principal.
   *
   * The approval screen renders it, so nobody mistakes an agent that merely
   * cooperates for one the runtime is interposed in front of.
   */
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
    body: {
      hostname: options.host ?? hostname(),
      ...(options.label === undefined ? {} : { label: options.label }),
      /* Omitted for an advisory principal, which signs no bytes there is a key
         to check. The door enforces that split rather than this side. */
      ...(options.connection === 'mcp' ? {} : { publicKey }),
      runtimeVersion: CLI_VERSION,
      ...(options.mode === undefined ? {} : { mode: options.mode }),
      ...(options.connection === undefined ? {} : { connection: options.connection }),
    },
  });
  if (answer.status !== 200 && answer.status !== 201) {
    /* A 404 is not a refusal and reading as one sent somebody to argue with an
       administrator about a permission, when what is actually there is a host that
       does not serve this API. */
    const missing = answer.status === 404 || answer.status === 501;
    throw new EnrolmentRefused(
      missing
        ? `${options.baseUrl} has no device-enrolment endpoint (${answer.status}), so it is not a Memnox control plane.\n` +
            'Point at the right one with "memnox login --url <base>". This machine is unchanged.'
        : `the control plane refused the request (${answer.status}).`,
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
 * How long to leave between polls, whatever the control plane asked for.
 *
 * The floor is the important half. A deployment that sends nothing, or sends a
 * zero, left this polling as fast as the network would answer: a loop that
 * looks like a hang from the outside and like an attack from the other end,
 * and the rate limiter that eventually stops answering turns the wait into a
 * failure. The ceiling is politeness to whoever is watching the screen, because
 * a minute between polls is a minute of nothing happening after they approved.
 */
const POLL_FLOOR_MS = 1_000;
const POLL_CEILING_MS = 30_000;

function pollEvery(offer: DeviceOffer): number {
  const asked = offer.intervalSeconds * 1000;
  if (!Number.isFinite(asked)) return POLL_FLOOR_MS;
  return Math.min(Math.max(asked, POLL_FLOOR_MS), POLL_CEILING_MS);
}

/** How long a person has to answer, in the words a screen says it in. */
export function goodFor(offer: DeviceOffer, now: number = Date.now()): string {
  const minutes = Math.round((offer.expiresAt - now) / 60_000);
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
  const sleep = seams.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = seams.now ?? Date.now;
  const every = pollEvery(offer);

  while (now() < offer.expiresAt) {
    const collected = await collect(baseUrl, offer.deviceCode);
    if (collected !== null) return collected;
    await sleep(every);
  }
  throw new EnrolmentRefused(ENROL_REFUSAL.EXPIRED);
}

/** Where a person goes to approve, printed for them to open. */
/**
 * Where to send somebody to approve this machine.
 *
 * The control plane's own answer wins, because only the deployment knows where
 * its console is: the base URL here is an API that serves no pages, and on
 * every deployment that has a console at all the two are different origins.
 * Deriving the address from the API base sent people to a 404.
 *
 * Falling back to that derivation anyway, for a control plane too old to say.
 * It is wrong in the same way it always was, but it is not a regression, and
 * the alternative is printing no address at all to somebody whose console does
 * happen to share the origin.
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
 * Whether that address carries the code already, which is what makes opening a
 * browser enough on its own. Where it does not, somebody has to type the eight
 * characters into a console they found themselves, and that is the one case
 * where the code is worth the space on screen.
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
    /* What the workspace has this machine set to, recorded as heard rather than
       applied. Without it the first heartbeat after enrolling reads as a change
       and rewrites `config.toml` — which is how logging in would quietly move a
       machine somebody had deliberately put in `advise`. */
    ...(isEnforcementMode(collected.mode) ? { cloudMode: collected.mode } : {}),
  };
}

export { CloudUnreachable };
