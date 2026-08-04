import type { FastifyInstance } from 'fastify';
import { API_ROLE } from '@memnox/core';
import { readRuntimeStatus } from '../runtime-status';
import { renderDashboard } from './dashboard-page';
import type { RouteContext } from './route-context';

const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';

/**
 * The one route a browser is ever pointed at. `/` used to 404, which is what
 * someone opening the address the CLI just printed actually saw.
 *
 * Guarded at viewer like every other read: a keyless loopback runtime resolves
 * to admin and the page opens, while a runtime with keys asks for one rather
 * than serving its audit trail to whoever finds the port.
 */
export function registerDashboardRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
    const status = await readRuntimeStatus(ctx.gateway, ctx.config);
    return reply.type(HTML_CONTENT_TYPE).send(renderDashboard(status));
  });

  /** The same numbers as JSON, for anything that would rather not parse HTML. */
  app.get('/v1/status', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
    return readRuntimeStatus(ctx.gateway, ctx.config);
  });
}
