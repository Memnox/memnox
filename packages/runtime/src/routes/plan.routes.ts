import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AgentPlan, PlanStep } from '@memnox/core';
import { advancePlan, closePlan } from '@memnox/core';
import { bearerToken, type RouteContext } from './route-context';

/** Declared plans: an agent narrows itself to one step at a time. */
export function registerPlanRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.post('/v1/plans', async (request, reply) => {
    const token = bearerToken(request);
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const agent = await ctx.gateway.agents.resolveByToken(token);
    if (!agent) return reply.code(401).send({ error: 'unauthorized' });

    const body = request.body as { sessionId?: string; steps?: unknown } | undefined;
    const sessionId = body === undefined ? undefined : body.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return reply.code(400).send({ error: '"sessionId" is required' });
    }
    const steps = parseSteps(body === undefined ? undefined : body.steps);
    if (steps === null) {
      return reply
        .code(400)
        .send({ error: '"steps" must be [{ name, allows: [pattern] }]' });
    }

    // One open plan per session: a second would let an agent pick whichever
    // scope suits the action it wants next.
    const existing = await ctx.plans.findBySession(sessionId);
    if (existing !== null) {
      return reply
        .code(409)
        .send({ error: 'this session already has an open plan', planId: existing.id });
    }

    const plan: AgentPlan = {
      id: randomUUID(),
      sessionId,
      agentId: agent.id,
      steps,
      current: 0,
      declaredAt: new Date().toISOString(),
    };
    await ctx.plans.save(plan);
    return reply.code(201).send(plan);
  });

  app.get('/v1/plans/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const plan = await requireOwnPlan(ctx, request, reply, id);
    if (!plan) return;
    return plan;
  });

  app.post('/v1/plans/:id/advance', async (request, reply) => {
    const { id } = request.params as { id: string };
    const plan = await requireOwnPlan(ctx, request, reply, id);
    if (!plan) return;
    const advanced = advancePlan(plan, new Date().toISOString());
    await ctx.plans.save(advanced);
    return advanced;
  });

  app.post('/v1/plans/:id/close', async (request, reply) => {
    const { id } = request.params as { id: string };
    const plan = await requireOwnPlan(ctx, request, reply, id);
    if (!plan) return;
    const closed = closePlan(plan, new Date().toISOString());
    await ctx.plans.save(closed);
    return closed;
  });
}

/** A plan is its agent's alone — another agent must not read or advance it. */
async function requireOwnPlan(
  ctx: RouteContext,
  request: FastifyRequest,
  reply: FastifyReply,
  id: string,
): Promise<AgentPlan | null> {
  const token = bearerToken(request);
  if (!token) {
    await reply.code(401).send({ error: 'unauthorized' });
    return null;
  }
  const agent = await ctx.gateway.agents.resolveByToken(token);
  if (!agent) {
    await reply.code(401).send({ error: 'unauthorized' });
    return null;
  }
  const plan = await ctx.plans.findById(id);
  if (!plan) {
    await reply.code(404).send({ error: 'plan not found' });
    return null;
  }
  if (plan.agentId !== agent.id) {
    await reply.code(403).send({ error: 'not your plan' });
    return null;
  }
  return plan;
}

function parseSteps(raw: unknown): PlanStep[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const steps: PlanStep[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { name, allows } = entry as { name?: unknown; allows?: unknown };
    if (typeof name !== 'string' || name.length === 0) return null;
    if (!Array.isArray(allows)) return null;
    if (allows.some((pattern) => typeof pattern !== 'string')) return null;
    steps.push({ name, allows: allows as string[] });
  }
  return steps;
}
