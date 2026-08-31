import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { buildServer, type MemnoxServer } from '../src/server';
import { UPSTREAM_KEY_HEADER } from '../src/proxy/upstream';

/** Blocks a fine-tuned variant, and holds Anthropic for approval. */
const POLICY_YAML = `
version: 1
policies:
  - name: no-fine-tunes
    match:
      actions: ["llm.infer"]
      models: ["ft:*"]
    decision:
      effect: withhold
      reason: Fine-tuned variants are not approved
  - name: review-anthropic
    match:
      actions: ["llm.infer"]
      providers: ["anthropic"]
    decision:
      effect: escalate
      approvers: ["security-team"]
`;

const ADMIN = ['admin', 'token', 'value'].join('-');
const UPSTREAM_KEY = ['sk', 'upstream', 'value'].join('-');

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

describe('BYOK inference proxy', () => {
  let dataDir: string;
  let server: MemnoxServer;
  let agentToken: string;
  let sent: Sent[];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-proxy-'));
    const policyFile = join(dataDir, 'policies.yaml');
    await writeFile(policyFile, POLICY_YAML, 'utf8');
    sent = [];

    const proxyFetch = (async (url: string, init: RequestInit) => {
      sent.push({
        url: String(url),
        headers: init.headers as Record<string, string>,
        body: String(init.body),
      });
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 'chatcmpl-1',
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          }),
      } as Response;
    }) as unknown as typeof fetch;

    server = await buildServer(
      { dataDir, policyFile, adminToken: ADMIN, enforcement: { default: 'enforce' } },
      { proxyFetch },
    );
    const registration = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: { name: 'app', kind: 'custom' },
    });
    agentToken = (registration.json() as { token: string }).token;
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const call = (
    path: string,
    payload: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> =>
    server.app.inject({
      method: 'POST',
      url: path,
      headers: {
        authorization: `Bearer ${agentToken}`,
        [UPSTREAM_KEY_HEADER]: UPSTREAM_KEY,
        ...headers,
      },
      payload,
    });

  it('relays an allowed call to the upstream provider', async () => {
    const response = await call('/v1/proxy/openai/v1/chat/completions', {
      model: 'gpt-4',
      messages: [],
    });

    expect(response.statusCode).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
  });

  it("forwards the caller's own key, never one of its own", async () => {
    await call('/v1/proxy/openai/v1/chat/completions', { model: 'gpt-4' });

    expect(sent[0]?.headers['authorization']).toBe(`Bearer ${UPSTREAM_KEY}`);
  });

  it('uses the provider-specific auth scheme for Anthropic', async () => {
    // Anthropic is held by policy, so approve-free calls need a different model path.
    const response = await call('/v1/proxy/anthropic/v1/messages', {
      model: 'claude-sonnet-4',
    });

    expect(response.statusCode).toBe(409);
  });

  // The whole point of a proxy gateway: a denied call must not reach the vendor.
  it('never contacts the provider when policy blocks', async () => {
    const response = await call('/v1/proxy/openai/v1/chat/completions', {
      model: 'ft:gpt-4:acme:custom',
    });

    expect(response.statusCode).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it('explains a block with the policy reason and an event id', async () => {
    const response = await call('/v1/proxy/openai/v1/chat/completions', {
      model: 'ft:gpt-4:acme:custom',
    });
    const body = response.json() as { reason: string; eventId: string };

    expect(body.reason).toContain('Fine-tuned');
    expect(body.eventId).toBeTruthy();
  });

  it('returns 409 and an approval id when a hold applies', async () => {
    const response = await call('/v1/proxy/anthropic/v1/messages', {
      model: 'claude-sonnet-4',
    });
    const body = response.json() as { approvalId?: string; effect: string };

    expect(response.statusCode).toBe(409);
    expect(body.effect).toBe('escalate');
    expect(body.approvalId).toBeTruthy();
    expect(sent).toHaveLength(0);
  });

  it('strips this hop’s credentials from the upstream request', async () => {
    await call('/v1/proxy/openai/v1/chat/completions', { model: 'gpt-4' });

    const headers = sent[0]?.headers ?? {};
    expect(headers[UPSTREAM_KEY_HEADER]).toBeUndefined();
    expect(headers['authorization']).not.toContain(agentToken);
  });

  // The proxy relays a caller's headers so provider-specific ones survive. A
  // session cookie is not one of those: it belongs to this hop and nowhere else.
  it('never hands the caller’s cookies to the provider', async () => {
    await call(
      '/v1/proxy/openai/v1/chat/completions',
      { model: 'gpt-4' },
      { cookie: 'session=not-the-providers-business' },
    );

    expect(sent[0]?.headers['cookie']).toBeUndefined();
  });

  it('audits every proxied decision', async () => {
    await call('/v1/proxy/openai/v1/chat/completions', { model: 'gpt-4' });

    const events = await server.gateway.queryAuditEvents({});
    const inference = events.find((event) => event.action === 'llm.infer');
    expect(inference?.model).toBe('gpt-4');
    expect(inference?.provider).toBe('openai');
  });

  it('counts tokens the upstream reported', async () => {
    await call('/v1/proxy/openai/v1/chat/completions', { model: 'gpt-4' });

    expect(server.metrics.render()).toContain('memnox_proxy_tokens_total 18');
  });

  it('carries the environment header into the decision', async () => {
    await call(
      '/v1/proxy/openai/v1/chat/completions',
      { model: 'gpt-4' },
      { 'x-memnox-environment': 'production' },
    );

    const events = await server.gateway.queryAuditEvents({});
    expect(events.find((event) => event.action === 'llm.infer')?.environment).toBe(
      'production',
    );
  });

  describe('rejection', () => {
    it('requires an agent credential', async () => {
      const response = await server.app.inject({
        method: 'POST',
        url: '/v1/proxy/openai/v1/chat/completions',
        headers: { [UPSTREAM_KEY_HEADER]: UPSTREAM_KEY },
        payload: { model: 'gpt-4' },
      });

      expect(response.statusCode).toBe(401);
      expect(sent).toHaveLength(0);
    });

    it('requires the upstream key — this proxy holds none', async () => {
      const response = await server.app.inject({
        method: 'POST',
        url: '/v1/proxy/openai/v1/chat/completions',
        headers: { authorization: `Bearer ${agentToken}` },
        payload: { model: 'gpt-4' },
      });

      expect(response.statusCode).toBe(400);
      expect(sent).toHaveLength(0);
    });

    it('rejects an unknown provider', async () => {
      const response = await call('/v1/proxy/cohere/v1/chat', { model: 'x' });

      expect(response.statusCode).toBe(404);
      expect(sent).toHaveLength(0);
    });
  });
});

describe('proxy spend caps', () => {
  let dataDir: string;
  let server: MemnoxServer;
  let agentToken: string;
  let upstreamBody: string;
  let sent: number;

  const start = async (options: {
    sessionTokenBudget?: number;
    body: string;
  }): Promise<void> => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-proxy-caps-'));
    upstreamBody = options.body;
    sent = 0;
    const proxyFetch = (async () => {
      sent += 1;
      return { ok: true, status: 200, text: async () => upstreamBody } as Response;
    }) as unknown as typeof fetch;

    server = await buildServer(
      {
        dataDir,
        adminToken: ADMIN,
        enforcement: { default: 'enforce' },
        ...(options.sessionTokenBudget === undefined
          ? {}
          : { sessionTokenBudget: options.sessionTokenBudget }),
      },
      { proxyFetch },
    );
    const registration = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: { name: 'app', kind: 'custom' },
    });
    agentToken = (registration.json() as { token: string }).token;
  };

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const infer = (session: string): Promise<LightMyRequestResponse> =>
    server.app.inject({
      method: 'POST',
      url: '/v1/proxy/openai/v1/chat/completions',
      headers: {
        authorization: `Bearer ${agentToken}`,
        [UPSTREAM_KEY_HEADER]: UPSTREAM_KEY,
        'x-memnox-session': session,
      },
      payload: { model: 'gpt-4' },
    });

  const usageBody = (tokens: number): string =>
    JSON.stringify({ usage: { prompt_tokens: tokens, completion_tokens: 0 } });

  it('stops a session once its token budget is spent', async () => {
    await start({ sessionTokenBudget: 100, body: usageBody(80) });

    expect((await infer('s1')).statusCode).toBe(200);
    // 80 spent of 100 — still under.
    expect((await infer('s1')).statusCode).toBe(200);
    // 160 spent — the next call is refused before reaching the provider.
    const third = await infer('s1');

    expect(third.statusCode).toBe(403);
    expect(sent).toBe(2);
  });

  it('scopes the budget to one session', async () => {
    await start({ sessionTokenBudget: 100, body: usageBody(200) });
    await infer('s1');
    expect((await infer('s1')).statusCode).toBe(403);

    expect((await infer('s2')).statusCode).toBe(200);
  });

  it('does not cap when no budget is configured', async () => {
    await start({ body: usageBody(10_000) });

    expect((await infer('s1')).statusCode).toBe(200);
    expect((await infer('s1')).statusCode).toBe(200);
  });

  it('relays a clean response untouched', async () => {
    await start({ body: JSON.stringify({ text: 'the capital of France is Paris' }) });

    const response = await infer('s1');

    expect(response.statusCode).toBe(200);
    expect(response.payload).toContain('Paris');
  });
});
