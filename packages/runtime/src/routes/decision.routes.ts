import type { FastifyInstance } from 'fastify';
import type { ActionRequest } from '@memnox/core';
import { DECISION_EFFECT } from '@memnox/core';
import { bearerToken, type RouteContext } from './route-context';

/** The decision surface: ask for a verdict, ask for a yes/no, or ask what would happen. */
export function registerDecisionRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.post('/v1/decision', async (request, reply) => {
    const token = bearerToken(request);
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const body = request.body as Partial<ActionRequest> | undefined;
    if (!body || !body.action) {
      return reply.code(400).send({ error: '"action" is required' });
    }
    return ctx.gateway.authorize(token, body as ActionRequest);
  });

  /** Authorization semantics: 200 when the action may proceed, 403 when it may not. */
  app.post('/v1/authorize', async (request, reply) => {
    const token = bearerToken(request);
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const body = request.body as Partial<ActionRequest> | undefined;
    if (!body || !body.action) {
      return reply.code(400).send({ error: '"action" is required' });
    }

    const decision = await ctx.gateway.authorize(token, body as ActionRequest);
    const authorized = decision.effect === 'allow';
    return reply.code(authorized ? 200 : 403).send({ authorized, decision });
  });

  /** Read-only "what would happen": nothing is audited and no approval is created. */
  app.post('/v1/evaluate-risk', async (request, reply) => {
    const token = bearerToken(request);
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const body = request.body as Partial<ActionRequest> | undefined;
    if (!body || !body.action) {
      return reply.code(400).send({ error: '"action" is required' });
    }
    return ctx.gateway.assess(token, body as ActionRequest);
  });
}
