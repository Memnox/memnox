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

/**
 * Ask the organization before you act.
 *
 * This client is the whole integration. It does not touch your tools, does not
 * execute anything, and does not need to know how you reach Slack or Stripe.
 * You keep execution; it answers whether, who, and what you are allowed to
 * know.
 *
 * It is also deliberately small. The organization is a service, and everything
 * that makes an answer worth trusting, the provenance of a fact, the ceiling on
 * an authority, who confirmed what, lives there rather than in a package that
 * every integrator would then be running a different version of.
 */
export class MemnoxOrganization {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: MemnoxOrganizationOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /**
   * The one call. Send who you are, what you intend, and what you rely on.
   *
   * The answer is a decision plus the context you are entitled to, so a caller
   * that acts on `allow` and stops on anything else is already correct.
   */
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

  /**
   * Who owns something, as the organization recorded it.
   *
   * Ownership here is a fact the company produced: somebody owns a decision,
   * and that decision governs what you asked about. An empty answer means
   * nobody has been recorded as owning it, which is a reason to ask rather than
   * to proceed.
   */
  owner(subject: string): Promise<Ownership> {
    return this.post<Ownership>('/ask/owner', { subject });
  }

  /** What has already been decided about a topic, so you do not re-decide it. */
  decisions(topic: string): Promise<Decided[]> {
    return this.post<Decided[]>('/ask/decisions', { topic });
  }

  /**
   * The rules that apply to a subject.
   *
   * Only verified policies come back. A policy nobody has confirmed is a
   * belief, and this never returns one, so anything here is something the
   * organization will hold you to.
   */
  policy(subject: string): Promise<Stated[]> {
    return this.rpc<Stated[]>('get_policy', { subject });
  }

  /**
   * What the organization states about one person: what they may authorize and
   * up to what, what they own, how they stand to others.
   *
   * Worth calling before naming somebody as an approver. An answer with no
   * authority in it means they cannot sign this off, whatever an org chart
   * elsewhere suggests.
   */
  person(address: string): Promise<Stated[]> {
    return this.rpc<Stated[]>('get_person', { person: address });
  }

  /**
   * Which agents this company runs for an action, tightest remit first.
   *
   * The answer to "this is not what I am for". An agent handed work outside its
   * own remit can pass it sideways instead of escalating to a person who will
   * only hand it to the agent that does this routinely. Never includes you, and
   * an empty answer means nobody is recorded for it — a reason to involve a
   * person, not to attempt it anyway.
   */
  agentsFor(action: string): Promise<AgentCandidate[]> {
    return this.post<AgentCandidate[]>('/ask/agents', { action });
  }

  /**
   * How the same action was routed the last few times somebody asked.
   *
   * The organization's behaviour rather than its statements: `decisions` is
   * what the company wrote down, this is what actually kept happening. A run of
   * escalations to one person is a rule nobody wrote, and a run of allows is
   * evidence the action is genuinely routine. Never carries what any of those
   * answers contained — only the verb, who it went to, and the stated intent.
   */
  precedent(action: string, limit?: number): Promise<Precedent[]> {
    return this.post<Precedent[]>('/ask/precedent', {
      action,
      ...(limit === undefined ? {} : { limit }),
    });
  }

  /**
   * Whether one fact may be repeated to one person.
   *
   * Answered against the recipient's clearance, never yours. The refusal
   * reason is safe to log and must not be repeated to the recipient either.
   */
  canShare(factId: string, recipient: string): Promise<ShareResponse> {
    return this.post<ShareResponse>('/ask/can-share', { factId, recipient });
  }

  /**
   * Evaluate, and throw unless the answer is a plain allow.
   *
   * For the call site that has nothing sensible to do with an escalation and
   * would otherwise write `if (!allowed) throw` slightly differently each time.
   * Anything that can handle an approval should use `evaluate` instead.
   */
  async require(request: EvaluateRequest): Promise<EvaluateResponse> {
    const answer = await this.evaluate(request);
    if (answer.decision !== DECISION.ALLOW) {
      throw new MemnoxOrganizationError(
        `${request.action} was not allowed: ${answer.decision} — ${answer.reason}`,
      );
    }
    return answer;
  }

  /**
   * A read that only the protocol endpoint exposes.
   *
   * Two of the questions an agent asks live behind MCP rather than behind a
   * route of their own, so this speaks JSON-RPC to reach them. Hidden here
   * rather than in the caller: which transport answers a question is Memnox's
   * business, not the integrator's.
   */
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
