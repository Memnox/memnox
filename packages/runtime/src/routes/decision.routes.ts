import type { FastifyInstance } from 'fastify';
import { DECISION_EFFECT, renderActionBriefing } from '@memnox/core';
import { readActionRequest } from './action-body';
import { bearerToken, type RouteContext } from './route-context';

/** The decision surface: ask for a verdict, ask for a yes/no, or ask what would happen. */
export function registerDecisionRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.post('/v1/decision', async (request, reply) => {
    const token = bearerToken(request);
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const action = readActionRequest(request.body);
    if (action === null) {
      return reply.code(400).send({ error: '"action" is required' });
    }
    return ctx.gateway.authorize(token, action);
  });

  /** Authorization semantics: 200 when the action may proceed, 403 when it may not. */
  app.post('/v1/authorize', async (request, reply) => {
    const token = bearerToken(request);
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const action = readActionRequest(request.body);
    if (action === null) {
      return reply.code(400).send({ error: '"action" is required' });
    }

    const decision = await ctx.gateway.authorize(token, action);
    const authorized = decision.effect === 'allow';
    return reply.code(authorized ? 200 : 403).send({ authorized, decision });
  });

  /** Read-only like evaluate-risk, but answers with the declared constraints. */
  app.post('/v1/context', async (request, reply) => {
    const token = bearerToken(request);
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const action = readActionRequest(request.body);
    if (action === null) {
      return reply.code(400).send({ error: '"action" is required' });
    }

    const briefing = await ctx.gateway.brief(token, action);
    return { briefing, text: renderActionBriefing(briefing) };
  });

  /** Read-only "what would happen": nothing is audited and no approval is created. */
  app.post('/v1/evaluate-risk', async (request, reply) => {
    const token = bearerToken(request);
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    const action = readActionRequest(request.body);
    if (action === null) {
      return reply.code(400).send({ error: '"action" is required' });
    }
    return ctx.gateway.assess(token, action);
  });
}
