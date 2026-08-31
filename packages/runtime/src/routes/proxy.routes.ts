import type { FastifyInstance } from 'fastify';
import { DECISION_EFFECT, type ActionRequest } from '@memnox/core';
import { METRIC } from '../metrics';
import {
  INFERENCE_ACTION,
  isUpstreamName,
  modelFromBody,
  UPSTREAM_KEY_HEADER,
  UPSTREAM_NAMES,
  upstreamAuth,
  upstreamUrl,
  usageFromResponse,
} from '../proxy/upstream';
import { bearerToken, type RouteContext } from './route-context';

/** Headers that belong to this hop, never to the upstream request. */
const STRIPPED = new Set([
  'authorization',
  UPSTREAM_KEY_HEADER,
  'host',
  'content-length',
  'connection',
  // A browser-driven caller would otherwise hand its session to the provider.
  'cookie',
]);

/** The caller's own key rides along; this runtime never stores one. */
export function registerProxyRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.post<{ Params: { provider: string; '*': string } }>(
    '/v1/proxy/:provider/*',
    async (request, reply) => {
      const token = bearerToken(request);
      if (!token) return reply.code(401).send({ error: 'unauthorized' });

      const { provider } = request.params;
      if (!isUpstreamName(provider)) {
        return reply
          .code(404)
          .send({ error: `unknown provider — one of: ${UPSTREAM_NAMES.join(', ')}` });
      }

      const upstreamKey = request.headers[UPSTREAM_KEY_HEADER];
      if (typeof upstreamKey !== 'string' || upstreamKey.length === 0) {
        return reply.code(400).send({
          error: `${UPSTREAM_KEY_HEADER} is required — this proxy holds no keys`,
        });
      }

      const body = request.body;
      const decisionRequest: ActionRequest = {
        action: INFERENCE_ACTION,
        target: request.params['*'],
        provider,
        ...(modelFromBody(body) === undefined ? {} : { model: modelFromBody(body) }),
        ...(typeof request.headers['x-memnox-environment'] === 'string'
          ? { environment: request.headers['x-memnox-environment'] }
          : {}),
        ...(typeof request.headers['x-memnox-session'] === 'string'
          ? { sessionId: request.headers['x-memnox-session'] }
          : {}),
      };

      const decision = await ctx.gateway.authorize(token, decisionRequest);
      // Nothing reaches the provider unless policy allowed it.
      if (decision.effect !== DECISION_EFFECT.ALLOW) {
        ctx.metrics.increment(METRIC.PROXY_BLOCKED_TOTAL);
        return reply.code(decision.effect === DECISION_EFFECT.WITHHOLD ? 403 : 409).send({
          error: 'withheld by policy',
          effect: decision.effect,
          reason: decision.reason,
          eventId: decision.eventId,
          approvalId: decision.approvalId,
        });
      }

      const forwarded = await ctx.proxyFetch(upstreamUrl(provider, request.params['*']), {
        method: 'POST',
        headers: {
          ...passthroughHeaders(request.headers),
          ...upstreamAuth(provider, upstreamKey),
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      ctx.metrics.increment(METRIC.PROXY_CALLS_TOTAL, { provider });
      const text = await forwarded.text();
      const parsed = safeJson(text);
      if (forwarded.ok) {
        const usage = usageFromResponse(parsed);
        const total = usage.inputTokens + usage.outputTokens;
        ctx.metrics.add(METRIC.PROXY_TOKENS_TOTAL, total);
        // Audited as llm.spend so the existing budget advisor sees real usage
        // and stops the next call once the session's allowance is gone.
        if (total > 0 && decisionRequest.sessionId !== undefined) {
          await ctx.gateway.recordSpend(
            token,
            total,
            decisionRequest.sessionId,
            decisionRequest.environment,
          );
        }
      }
      return reply
        .code(forwarded.status)
        .header('content-type', 'application/json')
        .send(text);
    },
  );
}

function passthroughHeaders(headers: Record<string, unknown>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (STRIPPED.has(name.toLowerCase())) continue;
    if (typeof value === 'string') kept[name] = value;
  }
  return kept;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // A non-JSON upstream body still gets relayed verbatim.
  }
}
