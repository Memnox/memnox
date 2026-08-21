import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { API_ROLE } from '@memnox/core';
import { isAuthorizedFor } from '../auth';
import { consoleCsp } from '../security-headers';
import { readRuntimeStatus } from '../runtime-status';
import { renderDashboard, renderDashboardGate } from './dashboard-page';
import { bearerToken, type RouteContext } from './route-context';

const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';
const NONCE_BYTE_LENGTH = 16;

/** A fresh nonce per response, so the page's inline script runs and an injected one does not. */
function serveConsole(
  reply: FastifyReply,
  render: (nonce: string) => string,
): FastifyReply {
  const nonce = randomBytes(NONCE_BYTE_LENGTH).toString('base64');
  // No copy of a page rendered from one tenant's decisions in a shared cache.
  return reply
    .header('content-security-policy', consoleCsp(nonce))
    .header('cache-control', 'no-store')
    .type(HTML_CONTENT_TYPE)
    .send(render(nonce));
}

/** `/` used to 404 — the address the CLI had just printed. */
export function registerDashboardRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/', async (request, reply) => {
    if (!isAuthorizedFor(bearerToken(request), ctx.config, API_ROLE.VIEWER)) {
      return serveConsole(reply, renderDashboardGate);
    }
    const status = await readRuntimeStatus(ctx.gateway, ctx.config);
    return serveConsole(reply, (nonce) => renderDashboard(status, nonce));
  });

  /** The same numbers as JSON, for anything that would rather not parse HTML. */
  app.get('/v1/status', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
    return readRuntimeStatus(ctx.gateway, ctx.config);
  });
}
