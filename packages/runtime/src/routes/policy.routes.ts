import type { FastifyInstance } from 'fastify';
import { API_ROLE } from '@memnox/core';
import { SIMULATION_SAMPLE_LIMIT } from '../config';
import {
  comparePolicySets,
  PolicyEngine,
  validatePolicyDocument,
  versionPolicySet,
  type SimulationCase,
} from '@memnox/policy-engine';
import type { RouteContext } from './route-context';

/** Reading and reloading the rule set. Authoring stays in files, not in this API. */
export function registerPolicyRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/v1/policies', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
    const policies = ctx.gateway.policies();
    return { ...versionPolicySet(policies), policies };
  });

  app.post('/v1/policies/validate', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
    try {
      const document = validatePolicyDocument(request.body);
      return { valid: true, ...versionPolicySet(document.policies) };
    } catch (err) {
      return reply.code(400).send({
        valid: false,
        errors: [err instanceof Error ? err.message : String(err)],
      });
    }
  });

  /**
   * Replaces the rule set. Writes the file first so the change survives a
   * restart and stays reviewable in a diff — the same invariant reload relies on.
   */
  app.put('/v1/policies', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.ADMIN)) return;
    if (!ctx.applyPolicies) {
      return reply.code(409).send({ error: 'runtime was started without a policy file' });
    }
    let document;
    try {
      document = validatePolicyDocument(request.body);
    } catch (err) {
      return reply.code(400).send({
        applied: false,
        errors: [err instanceof Error ? err.message : String(err)],
      });
    }
    try {
      const applied = await ctx.applyPolicies(document.policies);
      // Recorded only after a successful apply: history must describe what ran.
      await ctx.policyHistory.record(applied, new Date().toISOString());
      return { applied: true, ...versionPolicySet(applied) };
    } catch (err) {
      // The engine is only swapped after a successful write, so on failure the
      // runtime keeps enforcing what it had.
      return reply.code(500).send({
        applied: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get('/v1/policies/history', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
    // The rules themselves are on /v1/policies; this is the index.
    return (await ctx.policyHistory.list()).map(({ policies, ...entry }) => entry);
  });

  /** Restores an earlier rule set, recorded as a new version rather than a rewind. */
  app.post('/v1/policies/rollback/:version', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.ADMIN)) return;
    if (!ctx.applyPolicies) {
      return reply.code(409).send({ error: 'runtime was started without a policy file' });
    }
    const { version } = request.params as { version: string };
    const target = await ctx.policyHistory.findByVersion(version);
    if (!target) return reply.code(404).send({ error: 'unknown policy version' });

    try {
      const applied = await ctx.applyPolicies(target.policies);
      const entry = await ctx.policyHistory.record(
        applied,
        new Date().toISOString(),
        undefined,
        version,
      );
      return { rolledBack: true, restoredFrom: version, version: entry.version };
    } catch (err) {
      return reply.code(500).send({
        rolledBack: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * Answers "what would this change have done" against real history rather than
   * invented cases, which is what makes a rule change safe to publish.
   */
  app.post('/v1/policies/simulate', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
    let document;
    try {
      document = validatePolicyDocument(request.body);
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const history = await ctx.gateway.recentAuditEvents(SIMULATION_SAMPLE_LIMIT);
    const cases: SimulationCase[] = history.map((event) => ({
      action: event.action,
      ...(event.target === undefined ? {} : { target: event.target }),
      ...(event.environment === undefined ? {} : { environment: event.environment }),
      ...(event.agentName === undefined ? {} : { agentName: event.agentName }),
    }));

    const comparison = comparePolicySets(
      new PolicyEngine(ctx.gateway.policies()),
      new PolicyEngine(document.policies),
      cases,
    );
    return { sampled: cases.length, ...comparison };
  });

  /** Re-reads the file. Policies stay file-sourced so rules remain reviewable in a diff. */
  app.post('/v1/policies/reload', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.ADMIN)) return;
    if (!ctx.reloadPolicies) {
      return reply.code(409).send({ error: 'runtime was started without a policy file' });
    }
    try {
      const policies = await ctx.reloadPolicies();
      return { reloaded: true, ...versionPolicySet(policies) };
    } catch (err) {
      return reply.code(400).send({
        reloaded: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
