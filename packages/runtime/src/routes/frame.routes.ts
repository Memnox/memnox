import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { API_ROLE } from '@memnox/core';
import { FRAME_KIND, timelineOf, type Frame, type FrameKind } from '@memnox/ledger';
import { bearerToken, type RouteContext } from './route-context';

/** Only a seam reporting what it saw. A verdict frame is the gateway's to write. */
const REPORTABLE: readonly string[] = [
  FRAME_KIND.TOOL_CALL,
  FRAME_KIND.RESULT,
  FRAME_KIND.SIDE_EFFECT,
];

const MAX_SUMMARY_LENGTH = 500;

interface FrameBody {
  sessionId?: unknown;
  kind?: unknown;
  summary?: unknown;
  decisionId?: unknown;
  payloadDigest?: unknown;
}

function text(value: unknown, max = MAX_SUMMARY_LENGTH): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return null;
  return value;
}

/**
 * A seam reports what it saw, so a session is one timeline rather than a verdict with
 * the tool call missing from either side of it. Payloads never travel: a digest does,
 * and a ledger holding what an agent read would be the thing worth stealing.
 */
export function registerFrameRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.post('/v1/frames', async (request, reply) => {
    const token = bearerToken(request);
    if (token === null) return reply.code(401).send({ error: 'unauthorized' });

    const agent = await ctx.gateway.agents.resolveByToken(token);
    if (agent === null) return reply.code(401).send({ error: 'unauthorized' });

    const body = (request.body ?? {}) as FrameBody;
    const sessionId = text(body.sessionId, 200);
    if (sessionId === null) {
      return reply.code(400).send({ error: '"sessionId" is required' });
    }
    if (typeof body.kind !== 'string' || !REPORTABLE.includes(body.kind)) {
      return reply
        .code(400)
        .send({ error: `"kind" must be one of: ${REPORTABLE.join(', ')}` });
    }
    const summary = text(body.summary);
    if (summary === null) {
      return reply.code(400).send({
        error: `"summary" is required, at most ${MAX_SUMMARY_LENGTH} characters`,
      });
    }
    const digest = body.payloadDigest;
    if (digest !== undefined && text(digest, 64) === null) {
      return reply.code(400).send({ error: '"payloadDigest" must be a short digest' });
    }

    const frames = ctx.frames;
    if (frames === undefined) {
      return reply.code(503).send({ error: 'this runtime keeps no frames' });
    }

    const frame: Frame = {
      id: `frm_${randomUUID()}`,
      sessionId,
      agentId: agent.id,
      at: new Date().toISOString(),
      kind: body.kind as FrameKind,
      summary,
      ...(typeof body.decisionId === 'string' ? { decisionId: body.decisionId } : {}),
      ...(typeof digest === 'string' ? { payloadDigest: digest } : {}),
    };
    await frames.append(frame);
    return reply.code(201).send(frame);
  });

  app.get<{ Params: { sessionId: string } }>(
    '/v1/sessions/:sessionId/lineage',
    async (request, reply) => {
      if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
      return ctx.lineage.forSession(request.params.sessionId);
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    '/v1/sessions/:sessionId/frames',
    async (request, reply) => {
      if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
      const frames = ctx.frames;
      if (frames === undefined) return [];
      // One session, one timeline, in the order things happened.
      return timelineOf(await frames.bySession(request.params.sessionId));
    },
  );
}
