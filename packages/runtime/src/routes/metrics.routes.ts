import type { FastifyInstance } from 'fastify';
import { API_ROLE } from '@memnox/core';
import type { RouteContext } from './route-context';

const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** This pod's counters. Aggregation across pods is the scrape layer's job. */
export function registerMetricsRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/v1/metrics', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
    return reply.type(PROMETHEUS_CONTENT_TYPE).send(ctx.metrics.render());
  });
}
