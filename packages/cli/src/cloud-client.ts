import type { HttpTransport } from '@memnox/sdk';
import type { ResolvedCloud } from './cloud-connection';

/** What `/v1/me` says a credential can reach. */
export interface CloudIdentity {
  name?: string;
  role?: string;
  orgId?: string;
  workspaces?: string[];
}

/** A candidate organizational decision awaiting a human in the review queue. */
export interface CloudSuggestion {
  id: string;
  title: string;
  statement?: string;
  status: string;
  owner?: string;
  actions?: string[];
  confidence?: number;
}

/**
 * The workspace's chosen rules. Composed by the control plane from its own
 * state, so it answers for a machine no runtime can be dialled from.
 */
export interface CloudBundle {
  workspaceId: string;
  packs: string[];
  issuedAt: string;
  version: string;
  policyCount: number;
  policyNames: string[];
  policies: unknown[];
}

export interface CloudTimelineEntry {
  kind: string;
  id: string;
  occurredAt: string;
  event: Record<string, unknown>;
}

export class CloudApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CloudApiError';
  }
}

/**
 * The developer's read-only window onto their organization. Deliberately thin:
 * it reads what the control plane already exposes and decides nothing, so the
 * open runtime gains a client for a control plane, never a dependency on one.
 *
 * Takes its transport so tests exercise this code rather than a mock of it.
 */
export class CloudClient {
  constructor(
    private readonly connection: ResolvedCloud,
    private readonly transport: HttpTransport = defaultTransport,
  ) {}

  async me(): Promise<CloudIdentity> {
    return this.get<CloudIdentity>('/v1/me');
  }

  async suggestions(workspace: string): Promise<CloudSuggestion[]> {
    const body = await this.get<CloudSuggestion[] | { suggestions: CloudSuggestion[] }>(
      `/v1/workspaces/${encodeURIComponent(workspace)}/suggestions`,
    );
    return Array.isArray(body) ? body : body.suggestions;
  }

  async bundle(workspace: string): Promise<CloudBundle> {
    return this.get<CloudBundle>(
      `/v1/workspaces/${encodeURIComponent(workspace)}/bundle`,
    );
  }

  async timeline(workspace: string, limit: number): Promise<CloudTimelineEntry[]> {
    const body = await this.get<{ entries: CloudTimelineEntry[] }>(
      `/v1/workspaces/${encodeURIComponent(workspace)}/timeline?limit=${limit}`,
    );
    return body.entries;
  }

  private async get<T>(path: string): Promise<T> {
    const response = await this.transport(`${this.connection.url}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.connection.token}` },
    });
    if (!response.ok) {
      // The body is the control plane's own explanation; a bare status hides it.
      const detail = await response.text().catch(() => '');
      throw new CloudApiError(response.status, describe(response.status, path, detail));
    }
    return (await response.json()) as T;
  }
}

function describe(status: number, path: string, detail: string): string {
  if (status === 401 || status === 403) {
    return 'The control plane rejected this credential — run "memnox login" again.';
  }
  if (status === 404) {
    return `Not found on the control plane: ${path}. Check the workspace id.`;
  }
  // 502 is the control plane saying a runtime is down, not that it is down itself.
  if (status === 502) {
    return `The control plane could not reach that workspace's runtime (${detail.trim()}).`;
  }
  return `GET ${path} failed: ${status} ${detail.trim()}`;
}

const defaultTransport: HttpTransport = (url, init) =>
  fetch(url, { method: init.method, headers: init.headers, body: init.body });

/** What the control plane returns once a browser sign-in completes. */
interface CliTokenGrant {
  token: string;
  name: string;
  role: string;
  orgId: string;
}

/**
 * Trades a browser sign-in code for a machine credential. Unauthenticated by
 * design — the code and the verifier behind its challenge are what authorize
 * this call, so it takes a bare URL rather than a configured client.
 */
export async function exchangeCliCode(
  cloudUrl: string,
  code: string,
  verifier: string,
  label: string,
  transport: HttpTransport = defaultTransport,
): Promise<CliTokenGrant> {
  const response = await transport(`${cloudUrl}/v1/auth/cli/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, label }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new CloudApiError(
      response.status,
      `Sign-in could not be completed (${response.status}). ${detail.trim()}`,
    );
  }
  return (await response.json()) as CliTokenGrant;
}
