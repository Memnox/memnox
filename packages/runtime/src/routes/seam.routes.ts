import type { FastifyInstance } from 'fastify';
import { API_ROLE, ENFORCEMENT_MODE, SEAM_UNHEALTHY } from '@memnox/core';
import type { EnforcementMode, SeamUnhealthyBehaviour } from '@memnox/core';
import { isSeamKind } from '../seam-service';
import { bearerToken, type RouteContext } from './route-context';

const VALID_MODES: readonly string[] = Object.values(ENFORCEMENT_MODE);
const VALID_UNHEALTHY: readonly string[] = Object.values(SEAM_UNHEALTHY);

interface RegisterSeamBody {
  kind?: unknown;
  mode?: unknown;
  covers?: unknown;
  blindTo?: unknown;
  installedBy?: unknown;
  whenUnhealthy?: unknown;
}

function isGlobList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string' && entry.length > 0)
  );
}

/**
 * A seam declares itself, so coverage counts what is installed rather than what
 * somebody remembered to configure. Identity comes from the token, never the body:
 * a seam cannot register on behalf of an agent it is not.
 */
export function registerSeamRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.post('/v1/seams', async (request, reply) => {
    const token = bearerToken(request);
    if (token === null) return reply.code(401).send({ error: 'unauthorized' });

    const agent = await ctx.gateway.agents.resolveByToken(token);
    if (agent === null) return reply.code(401).send({ error: 'unauthorized' });

    const body = (request.body ?? {}) as RegisterSeamBody;
    if (!isSeamKind(body.kind)) {
      return reply.code(400).send({ error: '"kind" must be a known seam kind' });
    }
    if (body.mode !== undefined && !VALID_MODES.includes(String(body.mode))) {
      return reply
        .code(400)
        .send({ error: `"mode" must be one of: ${VALID_MODES.join(', ')}` });
    }
    if (body.covers !== undefined && !isGlobList(body.covers)) {
      return reply
        .code(400)
        .send({ error: '"covers" must be an array of non-empty action globs' });
    }
    if (body.blindTo !== undefined && !isGlobList(body.blindTo)) {
      return reply
        .code(400)
        .send({ error: '"blindTo" must be an array of non-empty strings' });
    }
    if (
      body.whenUnhealthy !== undefined &&
      !VALID_UNHEALTHY.includes(String(body.whenUnhealthy))
    ) {
      return reply
        .code(400)
        .send({ error: `"whenUnhealthy" must be one of: ${VALID_UNHEALTHY.join(', ')}` });
    }

    const seam = await ctx.seamService.register({
      agentId: agent.id,
      kind: body.kind,
      ...(body.mode === undefined ? {} : { mode: body.mode as EnforcementMode }),
      ...(body.covers === undefined ? {} : { covers: body.covers }),
      ...(body.blindTo === undefined ? {} : { blindTo: body.blindTo }),
      ...(typeof body.installedBy === 'string' ? { installedBy: body.installedBy } : {}),
      ...(body.whenUnhealthy === undefined
        ? {}
        : { whenUnhealthy: body.whenUnhealthy as SeamUnhealthyBehaviour }),
    });
    return reply.code(201).send(seam);
  });

  app.delete<{ Params: { id: string } }>('/v1/seams/:id', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.ADMIN)) return;
    const removed = await ctx.seamService.remove(request.params.id);
    if (!removed) return reply.code(404).send({ error: 'no such seam' });
    return reply.code(204).send();
  });
}
