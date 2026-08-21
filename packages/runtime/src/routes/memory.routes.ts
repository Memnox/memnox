import type { FastifyInstance } from 'fastify';
import { API_ROLE } from '@memnox/core';
import { DECISION_STATUS, type DecisionStatus } from '@memnox/memory';
import type { RouteContext } from './route-context';

const VALID_DECISION_STATUSES: readonly string[] = Object.values(DECISION_STATUS);

interface MemorySearchBody {
  query?: string;
  limit?: number;
}

interface DecisionBody {
  title?: string;
  statement?: string;
  owner?: string;
  actions?: string[];
  targets?: string[];
  environments?: string[];
  enforcement?: string;
  reversibilityCost?: string;
  sourceType?: string;
  sourceRef?: string;
  reviewAfter?: string;
  /** ID of an existing decision this one replaces. */
  supersedes?: string;
}

/** Every corpus operation belongs to DecisionMemoryService; this validates shapes. */
export function registerMemoryRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const memory = ctx.decisionMemory;

  app.get('/v1/memory/decisions', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
    return memory.list();
  });

  app.post('/v1/memory/decisions', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.ADMIN)) return;
    const body = (request.body ?? {}) as DecisionBody;
    if (!body.title || !body.statement || !body.owner) {
      return reply
        .code(400)
        .send({ error: '"title", "statement", and "owner" are required' });
    }
    if (!Array.isArray(body.actions) || body.actions.length === 0) {
      return reply
        .code(400)
        .send({ error: '"actions" must be a non-empty pattern array' });
    }

    const outcome = await memory.record({
      title: body.title,
      statement: body.statement,
      owner: body.owner,
      actions: body.actions,
      targets: body.targets,
      environments: body.environments,
      enforcement: body.enforcement,
      reversibilityCost: body.reversibilityCost,
      sourceType: body.sourceType,
      sourceRef: body.sourceRef,
      reviewAfter: body.reviewAfter,
      supersedes: body.supersedes,
    });

    if (!outcome.ok) {
      if (outcome.reason === 'duplicate') {
        return reply.code(409).send({
          error: `equivalent active decision already exists: ${outcome.existingId}`,
        });
      }
      return reply.code(404).send({ error: 'decision to supersede not found' });
    }
    return reply.code(201).send(outcome.record);
  });

  app.post('/v1/memory/decisions/:id/status', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.ADMIN)) return;
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { status?: string };
    if (!body.status || !VALID_DECISION_STATUSES.includes(body.status)) {
      return reply.code(400).send({
        error: `"status" must be one of: ${VALID_DECISION_STATUSES.join(', ')}`,
      });
    }
    const updated = await memory.setStatus(id, body.status as DecisionStatus);
    if (!updated) return reply.code(404).send({ error: 'decision not found' });
    return updated;
  });

  app.get('/v1/memory/decisions/search', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
    const { q } = request.query as { q?: string };
    if (!q) return reply.code(400).send({ error: '"q" is required' });
    return memory.searchByKeyword(q);
  });

  app.post('/v1/memory/search', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
    const body = request.body as MemorySearchBody | undefined;
    if (!body || !body.query) {
      return reply.code(400).send({ error: '"query" is required' });
    }
    return memory.search(body.query, body.limit);
  });

  app.get('/v1/memory/digest', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
    return { digest: await memory.digest() };
  });

  app.get('/v1/memory/health', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
    return memory.health();
  });

  app.delete('/v1/memory/decisions/:id', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.ADMIN)) return;
    const { id } = request.params as { id: string };
    const removed = await memory.remove(id);
    if (!removed) return reply.code(404).send({ error: 'decision not found' });
    return { removed: true };
  });
}
