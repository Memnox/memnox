import type { FastifyInstance } from 'fastify';
import type { AgentKind, AgentStatus } from '@memnox/core';
import { AGENT_KIND, AGENT_STATUS, API_ROLE, computeTrustScore } from '@memnox/core';
import type { RouteContext } from './route-context';

const VALID_AGENT_KINDS: readonly string[] = Object.values(AGENT_KIND);
const VALID_AGENT_STATUSES: readonly string[] = Object.values(AGENT_STATUS);

interface RegisterAgentBody {
  name?: string;
  kind?: string;
  capabilities?: unknown;
  orgId?: string;
}

function isCapabilityList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((pattern) => typeof pattern === 'string' && pattern.length > 0)
  );
}

interface AgentStatusBody {
  status?: string;
}

/** Agent identity: registration, listing with trust scores, suspend/activate. */
export function registerAgentRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.post('/v1/agents', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.ADMIN)) return;
    const body = (request.body ?? {}) as RegisterAgentBody;
    if (!body.name || typeof body.name !== 'string') {
      return reply.code(400).send({ error: '"name" is required' });
    }
    const kind =
      body.kind && VALID_AGENT_KINDS.includes(body.kind)
        ? (body.kind as AgentKind)
        : AGENT_KIND.CUSTOM;
    if (body.capabilities !== undefined && !isCapabilityList(body.capabilities)) {
      return reply
        .code(400)
        .send({ error: '"capabilities" must be an array of non-empty pattern strings' });
    }
    const registration = await ctx.gateway.registerAgent(
      body.name,
      kind,
      body.capabilities,
      typeof body.orgId === 'string' && body.orgId.length > 0 ? body.orgId : undefined,
    );
    // The stored hash never leaves the runtime; this output gets pasted into logs.
    const { tokenHash: _tokenHash, ...agent } = registration.agent;
    return reply.code(201).send({ agent, token: registration.token });
  });

  app.get('/v1/agents', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
    const agents = await ctx.gateway.listAgents();
    // Token hashes never leave the runtime.
    return agents.map(({ tokenHash: _tokenHash, ...agent }) => ({
      ...agent,
      trustScore: computeTrustScore(agent.stats),
    }));
  });

  /** One agent's identity and current trust score, for a dashboard or a triage view. */
  app.get('/v1/agents/:id', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
    const { id } = request.params as { id: string };
    const agent = await ctx.gateway.agents.findById(id);
    if (!agent) return reply.code(404).send({ error: 'agent not found' });
    // Token hashes never leave the runtime.
    const { tokenHash: _tokenHash, ...rest } = agent;
    return { ...rest, trustScore: computeTrustScore(agent.stats) };
  });

  app.post('/v1/agents/:id/status', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.ADMIN)) return;
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as AgentStatusBody;
    if (!body.status || !VALID_AGENT_STATUSES.includes(body.status)) {
      return reply
        .code(400)
        .send({ error: `"status" must be one of: ${VALID_AGENT_STATUSES.join(', ')}` });
    }
    const agent = await ctx.gateway.setAgentStatus(id, body.status as AgentStatus);
    if (!agent) return reply.code(404).send({ error: 'agent not found' });
    const { tokenHash: _tokenHash, ...safe } = agent;
    return safe;
  });

  app.post('/v1/agents/:id/rotate', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.ADMIN)) return;
    const { id } = request.params as { id: string };
    const rotated = await ctx.gateway.rotateAgentToken(id);
    if (!rotated) return reply.code(404).send({ error: 'agent not found' });
    const { tokenHash: _tokenHash, ...safe } = rotated.agent;
    return reply.code(201).send({ agent: safe, token: rotated.token });
  });
}
