import type { FastifyInstance } from 'fastify';
import { API_ROLE } from '@memnox/core';
import { isAuthorizedFor } from '../auth';
import { readRuntimeStatus } from '../runtime-status';
import { renderDashboard, renderDashboardGate } from './dashboard-page';
import { bearerToken, type RouteContext } from './route-context';

const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';

/**
 * The one route a browser is ever pointed at. `/` used to 404, which is what
 * someone opening the address the CLI just printed actually saw.
 *
 * A keyless loopback runtime resolves to admin and the console opens with its
 * numbers already rendered. A runtime with keys serves a page that asks for a
 * token instead — a browser cannot put a bearer header on a navigation, so
 * guarding this the way `/v1/status` is guarded meant a keyed deployment served
 * `{"error":"unauthorized"}` and nothing a person could act on. The gate page
 * carries no decisions, no rules, and no agents; every one of those still comes
 * from the guarded JSON endpoints, with the token the page collected.
 */
export function registerDashboardRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/', async (request, reply) => {
    if (!isAuthorizedFor(bearerToken(request), ctx.config, API_ROLE.VIEWER)) {
      return reply.type(HTML_CONTENT_TYPE).send(renderDashboardGate());
    }
    const status = await readRuntimeStatus(ctx.gateway, ctx.config);
    return reply.type(HTML_CONTENT_TYPE).send(renderDashboard(status));
  });

  /** The same numbers as JSON, for anything that would rather not parse HTML. */
  app.get('/v1/status', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
    return readRuntimeStatus(ctx.gateway, ctx.config);
  });
}
