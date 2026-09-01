import { MemnoxApiError } from '@memnox/sdk';
import { describeConnectionFailure, ENV_RUNTIME_URL } from './connection';
import { DEFAULT_BASE_URL } from './defaults';

/**
 * What the runtime said, without the request that carried it. The SDK names the verb
 * and path because a caller building on it wants them; a person at a terminal reading
 * `GET /v1/agents/levels/readiness failed: {"error":"no such agent"}` does not.
 */
function fromRuntime(err: MemnoxApiError): string {
  const detail = err.message.replace(/^[A-Z]+ \S+ failed: /, '');
  try {
    const parsed: unknown = JSON.parse(detail);
    if (typeof parsed === 'object' && parsed !== null) {
      const named = (parsed as { error?: unknown }).error;
      if (typeof named === 'string' && named.length > 0) return named;
    }
  } catch {
    // Not JSON: the runtime answered with plain text, which is already readable.
  }
  return detail;
}

/** The single failure path: "fetch failed" names neither the address nor the fix. */
export function explain(err: unknown, env: NodeJS.ProcessEnv = process.env): string {
  const url = env[ENV_RUNTIME_URL] ?? DEFAULT_BASE_URL;
  const connection = describeConnectionFailure(err, url);
  if (connection !== null) return connection;
  if (err instanceof MemnoxApiError) return fromRuntime(err);
  return err instanceof Error ? err.message : String(err);
}
