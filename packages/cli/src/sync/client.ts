import { HTTP, secondsToMs } from '@memnox/core';

/**
 * The only module here that reaches a network, as `no-network-outside-sync.test.ts` asserts.
 * Plain requests with no retry and no queue, because each caller decides what a failure means.
 */

/** Short: a machine waiting on a control plane must not hold up an agent. */
const TIMEOUT_MS = secondsToMs(10);

export interface CloudResponse<T> {
  status: number;
  /** Absent on 304 and on any status with no body worth reading. */
  body?: T;
  etag?: string;
}

interface CloudRequest {
  baseUrl: string;
  path: string;
  // `DELETE` revokes an offboarded agent's credential, or the reach would outlive the config.
  method?: 'GET' | 'POST' | 'DELETE';
  /** The machine credential, where the route wants one. */
  token?: string;
  body?: unknown;
  /** Sent verbatim, and `body` ignored, for a request whose exact bytes are signed. */
  rawBody?: string;
  /** Ed25519 over `rawBody`, base64. Sent with `machineId` or not at all. */
  signature?: string;
  machineId?: string;
  /** Sent as `If-None-Match`, so an unchanged bundle costs one round trip. */
  ifNoneMatch?: string;
  timeoutMs?: number;
}

/** Unreachable, refused, or timed out, which the caller cannot tell apart and need not. */
export class CloudUnreachable extends Error {
  constructor(readonly because: string) {
    super(`the control plane could not be reached: ${because}`);
  }
}

/** A loopback control plane is somebody developing against one, and is not a risk. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Whether two addresses are the same control plane, compared by origin in one place so
 * callers cannot disagree. Unparseable compares the strings, which errs toward asking.
 */
export function sameControlPlane(one: string, two: string): boolean {
  try {
    return new URL(one).origin === new URL(two).origin;
  } catch {
    return one === two;
  }
}

/**
 * Refused rather than downgraded, because every call carries a bearer token and TLS is
 * what authenticates the bundle. Checked here, the choke point a hand-edited account reaches.
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
  const payload =
    request.rawBody ??
    (request.body === undefined ? undefined : JSON.stringify(request.body));

  try {
    const response = await fetch(new URL(request.path, request.baseUrl), {
      method: request.method ?? 'GET',
      headers: headersFor(request, payload !== undefined),
      signal: controller.signal,
      ...(payload === undefined ? {} : { body: payload }),
    });
    return await responseOf<T>(response);
  } catch (err) {
    throw new CloudUnreachable(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

function headersFor(request: CloudRequest, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (request.token !== undefined) {
    headers['authorization'] = `Bearer ${request.token}`;
  }
  if (request.ifNoneMatch !== undefined) {
    headers['if-none-match'] = `"${request.ifNoneMatch}"`;
  }
  if (hasBody) headers['content-type'] = 'application/json';

  // Both or neither, because the control plane refuses a lone one.
  if (request.machineId !== undefined && request.signature !== undefined) {
    headers['x-memnox-machine'] = request.machineId;
    headers['x-memnox-signature'] = request.signature;
  }
  return headers;
}

async function responseOf<T>(response: Response): Promise<CloudResponse<T>> {
  const etag = response.headers.get('etag');
  return {
    status: response.status,
    ...(etag === null ? {} : { etag: etag.replace(/^W\/|"/g, '') }),
    ...(response.status === HTTP.NOT_MODIFIED
      ? {}
      : { body: await readJson<T>(response) }),
  };
}

/** A body that is not JSON is not an answer; the status still is. */
async function readJson<T>(response: Response): Promise<T | undefined> {
  try {
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}
