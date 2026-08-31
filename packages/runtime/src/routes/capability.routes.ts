import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { API_ROLE, LEASE_DEFAULT_TTL_SECONDS, type Capability } from '@memnox/core';
import { bearerToken, type RouteContext } from './route-context';

interface GrantBody {
  agentId?: unknown;
  operation?: unknown;
  scope?: unknown;
  ttlSeconds?: unknown;
  policyId?: unknown;
}

interface LeaseBody {
  capabilityId?: unknown;
  target?: unknown;
  scope?: unknown;
  environment?: unknown;
  sessionId?: unknown;
}

function asScope(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const scope: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'string') return null;
    scope[key] = entry;
  }
  return scope;
}

/**
 * Ask by operation, not by secret. Nothing long-lived is handed to an agent: a request
 * is exchanged for a lease scoped to one operation, one resource and a few minutes, and
 * every issue is an ordinary decision so the ledger holds why a credential was held.
 */
export function registerCapabilityRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.post('/v1/capabilities', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.ADMIN)) return;
    const body = (request.body ?? {}) as GrantBody;

    if (typeof body.agentId !== 'string' || body.agentId.length === 0) {
      return reply.code(400).send({ error: '"agentId" is required' });
    }
    if (typeof body.operation !== 'string' || body.operation.length === 0) {
      return reply.code(400).send({ error: '"operation" is required' });
    }
    const scope = asScope(body.scope);
    if (scope === null) {
      return reply.code(400).send({ error: '"scope" must be an object of strings' });
    }
    if (
      body.ttlSeconds !== undefined &&
      (typeof body.ttlSeconds !== 'number' || body.ttlSeconds <= 0)
    ) {
      return reply.code(400).send({ error: '"ttlSeconds" must be a positive number' });
    }

    const capability: Capability = {
      id: `cap_${randomUUID()}`,
      agentId: body.agentId,
      operation: body.operation,
      scope,
      ttlSeconds:
        typeof body.ttlSeconds === 'number' ? body.ttlSeconds : LEASE_DEFAULT_TTL_SECONDS,
      ...(typeof body.policyId === 'string' ? { policyId: body.policyId } : {}),
    };
    await ctx.broker.grant(capability);
    return reply.code(201).send(capability);
  });

  app.get<{ Params: { agentId: string } }>(
    '/v1/agents/:agentId/capabilities',
    async (request, reply) => {
      if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
      return ctx.broker.capabilitiesFor(request.params.agentId);
    },
  );

  app.post('/v1/leases', async (request, reply) => {
    const token = bearerToken(request);
    if (token === null) return reply.code(401).send({ error: 'unauthorized' });

    const body = (request.body ?? {}) as LeaseBody;
    if (typeof body.capabilityId !== 'string' || body.capabilityId.length === 0) {
      return reply.code(400).send({ error: '"capabilityId" is required' });
    }
    if (typeof body.target !== 'string' || body.target.length === 0) {
      return reply.code(400).send({ error: '"target" is required' });
    }
    const scope = asScope(body.scope);
    if (scope === null) {
      return reply.code(400).send({ error: '"scope" must be an object of strings' });
    }

    const outcome = await ctx.broker.issue(token, {
      capabilityId: body.capabilityId,
      target: body.target,
      scope,
      ...(typeof body.environment === 'string' ? { environment: body.environment } : {}),
      ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
    });
    // A refusal to issue is an ordinary verdict, so it reads like one.
    if (!outcome.issued) return reply.code(403).send(outcome);
    return reply.code(201).send(outcome.lease);
  });

  app.post<{ Params: { id: string } }>(
    '/v1/leases/:id/redeem',
    async (request, reply) => {
      const token = bearerToken(request);
      if (token === null) return reply.code(401).send({ error: 'unauthorized' });

      const agent = await ctx.gateway.agents.resolveByToken(token);
      if (agent === null) return reply.code(401).send({ error: 'unauthorized' });

      const lease = await ctx.broker.redeem(request.params.id);
      // Expiry belongs to the issuer: a holder asking about a dead lease is told no,
      // and one asking about somebody else's is told the same thing.
      if (lease === null || lease.agentId !== agent.id) {
        return reply.code(404).send({ error: 'no live lease by that id' });
      }
      return lease;
    },
  );

  app.get<{ Params: { agentId: string } }>(
    '/v1/agents/:agentId/leases',
    async (request, reply) => {
      if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
      return ctx.broker.leasesFor(request.params.agentId);
    },
  );
}
