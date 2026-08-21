import type { FastifyInstance } from 'fastify';
import { API_ROLE, parseEnvironmentModes } from '@memnox/core';
import type { RouteContext } from './route-context';

/** The mode was a startup flag alone, which left a control plane nothing to change. */
export function registerEnforcementRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/v1/enforcement', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
    return ctx.gateway.enforcement();
  });

  /** Persisted before the swap, so a restart keeps what was asked for. */
  app.put('/v1/enforcement', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.ADMIN)) return;

    const parsed = parseEnvironmentModes(request.body);
    if (typeof parsed === 'string') {
      return reply.code(400).send({ applied: false, error: parsed });
    }

    /* Merged, not replaced. A caller that names two environments is not saying
       anything about the default, and dropping it would silently move every
       unnamed environment onto the fail-closed library default. */
    const current = ctx.gateway.enforcement();
    const fallback = parsed.default ?? current.default;
    const environments = { ...current.environments, ...parsed.environments };
    const next = {
      ...(fallback === undefined ? {} : { default: fallback }),
      ...(Object.keys(environments).length === 0 ? {} : { environments }),
    };

    if (ctx.persistEnforcement !== undefined) {
      try {
        await ctx.persistEnforcement(next);
      } catch (err) {
        // Nothing is swapped, so the runtime keeps applying what it had.
        return reply.code(500).send({
          applied: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await ctx.gateway.useEnforcement(next);
    return { applied: true, ...next };
  });
}
