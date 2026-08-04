import { describe, expect, it, vi } from 'vitest';
import { MemnoxOrganization, MemnoxOrganizationError } from '../src/client';
import { DECISION, isHeld, mayProceed, type EvaluateResponse } from '../src/types';

const answer = (over: Partial<EvaluateResponse> = {}): EvaluateResponse => ({
  decision: DECISION.ALLOW,
  reason: 'no policy matched',
  approvers: [],
  policies: [],
  context: [],
  constraints: [],
  missingContext: [],
  withheld: 0,
  ...over,
});

const client = (impl: typeof globalThis.fetch): MemnoxOrganization =>
  new MemnoxOrganization({
    token: 'grant',
    workspace: 'acme',
    baseUrl: 'https://example.test',
    fetch: impl,
  });

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200 });

describe('evaluate', () => {
  it('sends the grant and the workspace, and posts JSON', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return ok(answer());
    }) as unknown as typeof globalThis.fetch;

    await client(fetchImpl).evaluate({ action: 'payment.refund' });

    const [call] = calls;
    expect(call?.url).toBe('https://example.test/v1/workspaces/acme/evaluate');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer grant');
    expect(JSON.parse(String(call?.init.body))).toEqual({
      action: 'payment.refund',
    });
  });

  it('escapes a workspace id rather than pasting it into the path', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return ok(answer());
    }) as unknown as typeof globalThis.fetch;

    await new MemnoxOrganization({
      token: 'grant',
      workspace: 'acme/../other',
      baseUrl: 'https://example.test',
      fetch: fetchImpl,
    }).evaluate({ action: 'a' });

    expect(seen[0]).toContain('acme%2F..%2Fother');
  });

  it('never fails open when the organization cannot be reached', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;

    await expect(
      client(fetchImpl).evaluate({ action: 'payment.refund' }),
    ).rejects.toBeInstanceOf(MemnoxOrganizationError);
  });

  it('carries the status through on a refusal', async () => {
    const fetchImpl = (async () =>
      new Response('an ask grant is required', {
        status: 401,
      })) as unknown as typeof globalThis.fetch;

    await expect(client(fetchImpl).evaluate({ action: 'a' })).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe('require', () => {
  it('throws on anything that is not a plain allow', async () => {
    const fetchImpl = (async () =>
      ok(
        answer({ decision: DECISION.ESCALATE, reason: 'the CFO authorizes this' }),
      )) as unknown as typeof globalThis.fetch;

    await expect(client(fetchImpl).require({ action: 'payment.refund' })).rejects.toThrow(
      /escalate/,
    );
  });

  it('returns the answer when it is allowed', async () => {
    const fetchImpl = (async () => ok(answer())) as unknown as typeof globalThis.fetch;
    await expect(
      client(fetchImpl).require({ action: 'payment.refund' }),
    ).resolves.toMatchObject({ decision: 'allow' });
  });
});

describe('precedent', () => {
  const calling = (): {
    calls: Array<{ url: string; body: unknown }>;
    fetchImpl: typeof globalThis.fetch;
  } => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as unknown,
      });
      return ok([]);
    }) as unknown as typeof globalThis.fetch;
    return { calls, fetchImpl };
  };

  it('asks the organization what happened the last time', async () => {
    const { calls, fetchImpl } = calling();

    await client(fetchImpl).precedent('payment.refund');

    expect(calls[0]?.url).toBe('https://example.test/v1/workspaces/acme/ask/precedent');
    expect(calls[0]?.body).toEqual({ action: 'payment.refund' });
  });

  /* Carried when asked for, and omitted entirely when not — the assertion
     above. A key sent as undefined is a key the server has to treat as unset,
     which is a second way of saying the same thing and one more to get wrong. */
  it('carries a limit that was asked for', async () => {
    const { calls, fetchImpl } = calling();

    await client(fetchImpl).precedent('payment.refund', 3);

    expect(calls[0]?.body).toEqual({ action: 'payment.refund', limit: 3 });
  });

  it('reads the occasions back', async () => {
    const fetchImpl = (async () =>
      ok([
        {
          occurredAt: '2026-08-01T00:00:00.000Z',
          verb: 'escalate',
          intent: 'a duplicate charge',
          to: ['manager@acme.test'],
        },
      ])) as unknown as typeof globalThis.fetch;

    const [occasion] = await client(fetchImpl).precedent('payment.refund');

    expect(occasion?.verb).toBe('escalate');
    expect(occasion?.to).toEqual(['manager@acme.test']);
  });
});

describe('reading an answer', () => {
  it('treats every non-allow as held', () => {
    expect(isHeld(DECISION.ALLOW)).toBe(false);
    for (const decision of [
      DECISION.DENY,
      DECISION.ASK,
      DECISION.ESCALATE,
      DECISION.DELEGATE,
      DECISION.CLARIFY,
    ]) {
      expect(isHeld(decision)).toBe(true);
    }
  });

  it('does not turn a withheld count into a refusal', () => {
    expect(mayProceed(answer({ withheld: 4 }))).toBe(true);
    expect(mayProceed(answer({ decision: DECISION.CLARIFY }))).toBe(false);
  });
});

describe('agentsFor', () => {
  it('asks which agents this action is for', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as unknown,
      });
      return ok([]);
    }) as unknown as typeof globalThis.fetch;

    await client(fetchImpl).agentsFor('payment.refund');

    expect(calls[0]?.url).toBe('https://example.test/v1/workspaces/acme/ask/agents');
    expect(calls[0]?.body).toEqual({ action: 'payment.refund' });
  });

  it('reads the candidates back, tightest remit first', async () => {
    const fetchImpl = (async () =>
      ok([
        { agentId: 'refund-bot', label: 'refunds', capabilities: ['payment.refund'] },
        { agentId: 'everything-bot', label: 'payments', capabilities: ['payment'] },
      ])) as unknown as typeof globalThis.fetch;

    const candidates = await client(fetchImpl).agentsFor('payment.refund');

    expect(candidates.map((each) => each.agentId)).toEqual([
      'refund-bot',
      'everything-bot',
    ]);
  });
});
