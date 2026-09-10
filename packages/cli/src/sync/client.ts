/**
 * The only module in this repository that reaches a network.
 *
 * `test/no-network-outside-sync.test.ts` asserts that, and it is the reason the
 * claim on the front page can be checked rather than believed: nothing calls out
 * until somebody runs `memnox login`, and this is the one file that could.
 *
 * Everything here is a plain conditional request. There is no retry loop and no
 * background queue — the caller decides what a failure means, because the answer
 * is different for a bundle (keep the last one) and for a heartbeat (say nothing).
 */

/** Short: a machine waiting on a control plane must not hold up an agent. */
const TIMEOUT_MS = 10_000;

interface CloudResponse<T> {
  status: number;
  /** Absent on 304 and on any status with no body worth reading. */
  body?: T;
  etag?: string;
}

interface CloudRequest {
  baseUrl: string;
  path: string;
  /* `DELETE` is here for one route: revoking the credential an agent was
     onboarded under. Offboarding that left a live credential behind would
     restore the config and leave the reach. */
  method?: 'GET' | 'POST' | 'DELETE';
  /** The machine credential, where the route wants one. */
  token?: string;
  body?: unknown;
  /**
   * Sent verbatim, for a request whose bytes are signed.
   *
   * The control plane verifies the raw body it received, so serialising twice
   * would sign one string and send another and the signature would never
   * verify. When this is set, `body` is ignored.
   */
  rawBody?: string;
  /** Ed25519 over `rawBody`, base64. Sent with `machineId` or not at all. */
  signature?: string;
  machineId?: string;
  /** Sent as `If-None-Match`, so an unchanged bundle costs one round trip. */
  ifNoneMatch?: string;
  timeoutMs?: number;
}

/** Unreachable, refused, or timed out — the caller cannot tell and does not need to. */
export class CloudUnreachable extends Error {
  constructor(readonly because: string) {
    super(`the control plane could not be reached: ${because}`);
  }
}

/** A loopback control plane is somebody developing against one, and is not a risk. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Refused rather than downgraded.
 *
 * Every call here carries the machine's bearer token, and the bundle it pulls
 * back has no signature of its own — TLS is the only thing authenticating either
 * direction. Over plain http the token is readable by anything on the path, and
 * the rules this machine then enforces are whatever that thing chose to return.
 * The check lives here rather than in `login` because it is the choke point: a
 * hand-edited `account.json` reaches this function too.
 */
export function insecureBaseUrl(baseUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return `"${baseUrl}" is not a URL`;
  }
  if (parsed.protocol === 'https:') return null;
  if (parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname)) return null;
  return `${baseUrl} is not https, and a token must not travel in the clear`;
}

export async function callCloud<T>(request: CloudRequest): Promise<CloudResponse<T>> {
  const insecure = insecureBaseUrl(request.baseUrl);
  if (insecure !== null) throw new CloudUnreachable(insecure);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? TIMEOUT_MS);

  const headers: Record<string, string> = { accept: 'application/json' };
  if (request.token !== undefined) {
    headers['authorization'] = `Bearer ${request.token}`;
  }
  if (request.ifNoneMatch !== undefined) {
    headers['if-none-match'] = `"${request.ifNoneMatch}"`;
  }
  const payload =
    request.rawBody ??
    (request.body === undefined ? undefined : JSON.stringify(request.body));
  if (payload !== undefined) headers['content-type'] = 'application/json';

  /* Both or neither: the control plane refuses a lone one rather than falling
     back to the credential the request also carries. */
  if (request.machineId !== undefined && request.signature !== undefined) {
    headers['x-memnox-machine'] = request.machineId;
    headers['x-memnox-signature'] = request.signature;
  }

  try {
    const response = await fetch(new URL(request.path, request.baseUrl), {
      method: request.method ?? 'GET',
      headers,
      signal: controller.signal,
      ...(payload === undefined ? {} : { body: payload }),
    });

    const etag = response.headers.get('etag');
    return {
      status: response.status,
      ...(etag === null ? {} : { etag: etag.replace(/^W\/|"/g, '') }),
      ...(response.status === 304 ? {} : { body: await readJson<T>(response) }),
    };
  } catch (err) {
    throw new CloudUnreachable(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

/** A body that is not JSON is not an answer; the status still is. */
async function readJson<T>(response: Response): Promise<T | undefined> {
  try {
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}
