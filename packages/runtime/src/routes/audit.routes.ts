import type { FastifyInstance } from 'fastify';
import type { AuditQuery } from '@memnox/core';
import { API_ROLE } from '@memnox/core';
import { DEFAULT_AUDIT_LIMIT, MAX_AUDIT_LIMIT } from '../config';
import { buildComplianceReport, renderAuditCsv } from '../reporting';
import type { RouteContext } from './route-context';

interface AuditQueryString {
  limit?: string;
  session?: string;
  agent?: string;
  org?: string;
  project?: string;
  from?: string;
  to?: string;
}

/** The proof surface: timeline queries, CSV evidence, compliance reports. */
export function registerAuditRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/v1/audit', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
    const query = request.query as AuditQueryString;
    const parsed = Number(query.limit ?? DEFAULT_AUDIT_LIMIT);
    const bounded = Math.min(
      Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AUDIT_LIMIT,
      MAX_AUDIT_LIMIT,
    );
    const filter: AuditQuery = {
      sessionId: query.session,
      agentId: query.agent,
      orgId: query.org,
      projectId: query.project,
      from: query.from,
      to: query.to,
      // A query with no explicit limit still gets the ceiling, never an unbounded scan.
      limit: query.limit ? bounded : MAX_AUDIT_LIMIT,
    };
    if (
      filter.sessionId ||
      filter.agentId ||
      filter.orgId ||
      filter.projectId ||
      filter.from ||
      filter.to
    ) {
      return ctx.gateway.queryAuditEvents(filter);
    }
    return ctx.gateway.recentAuditEvents(bounded);
  });

  app.get('/v1/audit/verify', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
    return ctx.gateway.verifyAuditChain();
  });

  app.get('/v1/audit/export.csv', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
    const { from, to } = request.query as AuditQueryString;
    const events = await ctx.gateway.queryAuditEvents({ from, to });
    return reply.type('text/csv').send(renderAuditCsv(events));
  });

  app.get('/v1/reports/compliance', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
    const { from, to } = request.query as AuditQueryString;
    const events = await ctx.gateway.queryAuditEvents({ from, to });
    return buildComplianceReport(events, { from, to });
  });
}
