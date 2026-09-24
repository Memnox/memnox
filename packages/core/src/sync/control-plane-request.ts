import type { Account } from './account';

/**
 * One bounded, authenticated JSON request to the control plane, for the seams that
 * must never be slowed by it. Null for anything that did not come back whole.
 */

export type Fetcher = typeof globalThis.fetch;

export interface ControlPlaneRequest {
  account: Pick<Account, 'baseUrl' | 'token'>;
  /** From the root, such as `/v1/workspaces/<id>/leases`. */
  path: string;
  body: unknown;
  method?: 'POST' | 'DELETE';
  fetcher: Fetcher;
  timeoutMs: number;
}

export interface ControlPlaneReply {
  status: number;
  ok: boolean;
  text: string;
}

export async function runControlPlaneRequest(
  request: ControlPlaneRequest,
): Promise<ControlPlaneReply | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  timer.unref?.();
  try {
    const response = await request.fetcher(`${request.account.baseUrl}${request.path}`, {
      method: request.method ?? 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${request.account.token}`,
      },
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
    return { status: response.status, ok: response.ok, text: await response.text() };
  } catch {
    // Unreachable, aborted or too slow: all of them mean nobody could tell us.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Parsed, or null where the body is empty or is not JSON. */
export function parseReplyBody(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
