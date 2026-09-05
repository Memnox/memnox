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
  method?: 'GET' | 'POST';
  /** The machine credential, where the route wants one. */
  token?: string;
  body?: unknown;
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

export async function callCloud<T>(request: CloudRequest): Promise<CloudResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? TIMEOUT_MS);

  const headers: Record<string, string> = { accept: 'application/json' };
  if (request.token !== undefined) {
    headers['authorization'] = `Bearer ${request.token}`;
  }
  if (request.ifNoneMatch !== undefined) {
    headers['if-none-match'] = `"${request.ifNoneMatch}"`;
  }
  if (request.body !== undefined) headers['content-type'] = 'application/json';

  try {
    const response = await fetch(new URL(request.path, request.baseUrl), {
      method: request.method ?? 'GET',
      headers,
      signal: controller.signal,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
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
