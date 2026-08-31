import type { FastifyInstance } from 'fastify';
import { API_ROLE, CONTAINMENT_KIND, type ContainmentKind } from '@memnox/core';
import { blindSpots, coverageFrom } from '../coverage';
import {
  censusGap,
  summarizeCensus,
  takeCensus,
  ungovernable,
} from '@memnox/organization';
import { DEFAULT_LEARN_WINDOW_DAYS } from '../learn-service';
import type { RouteContext } from './route-context';

const COVERAGE_WINDOW = 1_000;
/** A single-tenant runtime has one workspace, and it is this machine. */
const LOCAL_WORKSPACE = 'local';

const CONTAINMENT_KINDS: readonly string[] = Object.values(CONTAINMENT_KIND);

/** What is covered, and what stops an agent. Shape-checking only; the services decide. */
export function registerOperateRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/v1/coverage', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
    const events = await ctx.gateway.queryAuditEvents({ limit: COVERAGE_WINDOW });
    const seams = await ctx.seams.list();
    const window = coverageFrom({
      workspaceId: LOCAL_WORKSPACE,
      events,
      seams,
      installsEnforcing: 1,
      installsTotal: 1,
    });
    // Coverage without the blind spots reads as completeness, which it never is.
    return { ...window, blindTo: blindSpots(seams) };
  });

  app.get<{ Querystring: { days?: string } }>('/v1/learn', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.ADMIN)) return;
    const raw = request.query.days;
    const days = raw === undefined ? DEFAULT_LEARN_WINDOW_DAYS : Number(raw);
    if (!Number.isFinite(days) || days <= 0) {
      return reply.code(400).send({ error: '"days" must be a positive number' });
    }
    return ctx.learn.learn(days);
  });

  app.get('/v1/seams', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
    return ctx.seams.list();
  });

  app.get<{ Querystring: { tracked?: string } }>('/v1/census', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
    const { entries, unavailable } = await takeCensus(ctx.censusSources);
    const tracked = Number(request.query.tracked ?? '0');
    return {
      summary: summarizeCensus(entries),
      // The gap is theirs rather than ours, which is why the number they had is an input.
      gap: Number.isFinite(tracked) ? censusGap(entries, tracked) : null,
      ungovernable: ungovernable(entries),
      entries,
      unavailable,
    };
  });

  app.post('/v1/containment', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.ADMIN)) return;
    const body = request.body as Record<string, unknown> | undefined;
    const kind = readString(body, 'kind');
    if (kind === undefined || !CONTAINMENT_KINDS.includes(kind)) {
      return reply
        .code(400)
        .send({ error: `"kind" must be one of: ${CONTAINMENT_KINDS.join(', ')}` });
    }
    const reason = readString(body, 'reason');
    if (reason === undefined) {
      return reply.code(400).send({ error: '"reason" is required' });
    }
    const authorId = readString(body, 'authorId');
    if (authorId === undefined) {
      return reply.code(400).send({ error: '"authorId" is required' });
    }

    const outcome = await ctx.containment.contain({
      kind: kind as ContainmentKind,
      reason,
      authorId,
      ...pick(body, 'subjectId'),
      ...pick(body, 'restorePath'),
    });
    if (!outcome.contained) return reply.code(400).send({ error: outcome.reason });
    return reply.code(201).send(outcome.action);
  });
}

function readString(
  body: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (body === undefined) return undefined;
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value;
}

function pick(
  body: Record<string, unknown> | undefined,
  key: string,
): Record<string, string> {
  const value = readString(body, key);
  return value === undefined ? {} : { [key]: value };
}
