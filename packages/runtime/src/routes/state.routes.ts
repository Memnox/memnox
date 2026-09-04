import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  API_ROLE,
  STATE_FACT_KIND,
  validateStateFact,
  stateFactsInForce,
  type StateFact,
  type StateFactKind,
} from '@memnox/core';
import type { RouteContext } from './route-context';

const VALID_KINDS: readonly string[] = Object.values(STATE_FACT_KIND);

interface DeclareStateBody {
  kind?: unknown;
  scope?: unknown;
  reason?: unknown;
  source?: unknown;
  validUntil?: unknown;
}

function isKind(value: unknown): value is StateFactKind {
  return typeof value === 'string' && VALID_KINDS.includes(value);
}

function isScope(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === 'string' && entry.length > 0)
  );
}

/**
 * A freeze arrives from somewhere else — an incident tool, an operator, the cloud —
 * and is honoured here. The runtime never infers one: a condition it invented would
 * be a policy it wrote for itself.
 */
export function registerStateRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.post('/v1/state', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.ADMIN)) return reply;

    const body = (request.body ?? {}) as DeclareStateBody;
    if (!isKind(body.kind)) {
      return reply
        .code(400)
        .send({ error: `kind must be one of ${VALID_KINDS.join(', ')}` });
    }
    if (!isScope(body.scope)) {
      return reply.code(400).send({ error: 'scope must be a non-empty list of names' });
    }
    if (typeof body.reason !== 'string' || body.reason === '') {
      return reply
        .code(400)
        .send({ error: 'reason is required, verbatim from whoever declared it' });
    }
    if (typeof body.source !== 'string' || body.source === '') {
      return reply.code(400).send({
        error: 'source is required: a fact nobody is named for cannot be argued with',
      });
    }
    if (typeof body.validUntil !== 'string') {
      return reply.code(400).send({ error: 'validUntil is required' });
    }

    const fact: StateFact = {
      id: randomUUID(),
      kind: body.kind,
      scope: body.scope,
      reason: body.reason,
      source: body.source,
      declaredAt: new Date().toISOString(),
      validUntil: body.validUntil,
    };

    const refusals = validateStateFact(fact);
    if (refusals.length > 0) return reply.code(400).send({ error: refusals.join('; ') });

    await ctx.stateFacts.save(fact);
    return reply.code(201).send(fact);
  });

  app.get('/v1/state', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return reply;
    const facts = await ctx.stateFacts.list();
    const now = new Date().toISOString();
    /* Lapsed facts are returned too, marked: a reader asking why an action got through
       needs to see the freeze that expired an hour ago, not an empty list. */
    return reply.send({
      inForce: stateFactsInForce(facts, now),
      lapsed: facts.filter((fact) => fact.validUntil <= now),
    });
  });

  app.delete('/v1/state/:id', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.ADMIN)) return reply;
    const { id } = request.params as { id: string };
    const removed = await ctx.stateFacts.remove(id);
    if (!removed) return reply.code(404).send({ error: 'no such state fact' });
    return reply.send({ id, lifted: true });
  });
}
