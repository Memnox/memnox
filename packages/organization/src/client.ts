import {
  DECISION,
  type ContextResponse,
  type Decided,
  type EvaluateRequest,
  type EvaluateResponse,
  type AgentCandidate,
  type Ownership,
  type Precedent,
  type ShareResponse,
  type Stated,
} from './types';

export interface MemnoxOrganizationOptions {
  /** The grant minted for this agent. Never a person's credential. */
  token: string;
  /** Which organization's memory to ask. */
  workspace: string;
  /** Defaults to the hosted control plane. */
  baseUrl?: string;
  /** Per-request ceiling. A governance call that hangs must not hang the agent. */
  timeoutMs?: number;
  /** Injected in tests, and by anyone routing through their own transport. */
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_BASE_URL = 'https://api.memnox.com';
const DEFAULT_TIMEOUT_MS = 10_000;

export class MemnoxOrganizationError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MemnoxOrganizationError';
  }
}

/** Ask before you act: this touches no tools and executes nothing. */
export class MemnoxOrganization {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: MemnoxOrganizationOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /** The one call: who you are, what you intend, and what you rely on. */
  evaluate(request: EvaluateRequest): Promise<EvaluateResponse> {
    return this.post<EvaluateResponse>('/evaluate', request);
  }

  /** What the organization knows that bears on a question. */
  context(question: string, limit?: number): Promise<ContextResponse> {
    return this.post<ContextResponse>('/ask/context', {
      question,
      ...(limit === undefined ? {} : { limit }),
    });
  }

  /** Ownership is a fact the company produced, not an inference. */
  owner(subject: string): Promise<Ownership> {
    return this.post<Ownership>('/ask/owner', { subject });
  }

  /** What has already been decided about a topic, so you do not re-decide it. */
  decisions(topic: string): Promise<Decided[]> {
    return this.post<Decided[]>('/ask/decisions', { topic });
  }

  /** Only verified policies: an unconfirmed one is a belief, and this never returns it. */
  policy(subject: string): Promise<Stated[]> {
    return this.rpc<Stated[]>('get_policy', { subject });
  }

  /** Worth calling before naming somebody as an approver. */
  person(address: string): Promise<Stated[]> {
    return this.rpc<Stated[]>('get_person', { person: address });
  }

  /** The answer to "this is not what I am for", tightest remit first. */
  agentsFor(action: string): Promise<AgentCandidate[]> {
    return this.post<AgentCandidate[]>('/ask/agents', { action });
  }

  /** The organization's behaviour rather than its statements. */
  precedent(action: string, limit?: number): Promise<Precedent[]> {
    return this.post<Precedent[]>('/ask/precedent', {
      action,
      ...(limit === undefined ? {} : { limit }),
    });
  }

  /** Answered against the recipient's clearance, never yours. */
  canShare(factId: string, recipient: string): Promise<ShareResponse> {
    return this.post<ShareResponse>('/ask/can-share', { factId, recipient });
  }

  /** For a call site that has nothing sensible to do with an escalation. */
  async require(request: EvaluateRequest): Promise<EvaluateResponse> {
    const answer = await this.evaluate(request);
    if (answer.decision !== DECISION.ALLOW) {
      throw new MemnoxOrganizationError(
        `${request.action} was not allowed: ${answer.decision} — ${answer.reason}`,
      );
    }
    return answer;
  }

  /** Two questions live behind MCP rather than a route, so this speaks JSON-RPC. */
  private async rpc<T>(tool: string, args: Record<string, unknown>): Promise<T> {
    const answer = await this.post<{
      result?: {
        structuredContent?: unknown;
        isError?: boolean;
        content?: Array<{ text?: string }>;
      };
      error?: { message?: string };
    }>('/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    });

    if (answer.error !== undefined) {
      throw new MemnoxOrganizationError(`${tool}: ${answer.error.message ?? 'refused'}`);
    }
    const result = answer.result;
    if (result === undefined || result.isError === true) {
      const said = result?.content?.[0]?.text ?? 'no answer';
      throw new MemnoxOrganizationError(`${tool}: ${said}`);
    }
    return result.structuredContent as T;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}/v1/workspaces/${encodeURIComponent(this.options.workspace)}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      /* Never fail open. A caller that cannot reach the organization has not
         been told it may proceed, and turning that into a permissive default
         would make an outage the most dangerous state in the system. */
      throw new MemnoxOrganizationError(
        `could not reach the organization: ${String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new MemnoxOrganizationError(
        `${path} answered ${response.status}: ${await safeText(response)}`,
        response.status,
      );
    }
    return (await response.json()) as T;
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    // The body is already gone; the status is the whole message.
    return '';
  }
}
