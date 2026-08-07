import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AgentIdentity } from '@memnox/core';
import { METRIC } from '../metrics';
import type { EvaluateRequest } from '../organization-service';
import { hashToken } from '../token';
import { bearerToken, type RouteContext } from './route-context';

const RATE_WINDOW_S = 60;
const RATE_KEY_HASH_LENGTH = 16;
/** Key by token hash so raw credentials never become counter keys. */
const rateKey = (token: string): string =>
  `ask:${hashToken(token).slice(0, RATE_KEY_HASH_LENGTH)}`;

interface WorkspaceParams {
  workspace: string;
}

/** A credential that resolved, and the workspace it is entitled to. */
interface Admitted {
  agent: AgentIdentity;
  token: string;
}

/**
 * The organization protocol: one decision, and the questions that lead to it.
 *
 * Every route here validates a shape, resolves the credential to an agent, and
 * hands off. The workspace in the path is checked against the credential and
 * never trusted as a scope — `OrganizationService.workspaceOf` decides that,
 * and this module only refuses the mismatch.
 */
export function registerOrganizationRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): void {
  const organization = ctx.organization;

  /**
   * Resolves the credential and checks it against the workspace in the path.
   *
   * Fails closed on both: an unknown token and a token for another workspace
   * are the same answer, because distinguishing them would tell an unauthorized
   * caller which workspaces exist.
   */
  const admit = async (
    token: string | null,
    params: WorkspaceParams,
    reply: FastifyReply,
  ): Promise<Admitted | null> => {
    if (token === null) {
      void reply.code(401).send({ error: 'unauthorized' });
      return null;
    }
    /* Throttled before the credential is resolved, and keyed by its hash. Both
       halves matter: limiting after resolution leaves an unknown token free to
       hammer the lookup, and keying by anything shared would let one agent in a
       retry loop starve the others in the same organization. */
    const within = await ctx.rateLimiter.allow(
      rateKey(token),
      ctx.config.askRateLimitPerMinute,
      RATE_WINDOW_S,
    );
    if (!within) {
      ctx.metrics.increment(METRIC.RATE_LIMIT_REJECTIONS_TOTAL);
      void reply.code(429).send({ error: 'rate limit exceeded — slow down' });
      return null;
    }

    const agent = await organization.resolveAgent(token);
    if (agent === null || organization.workspaceOf(agent) !== params.workspace) {
      void reply.code(401).send({ error: 'unauthorized' });
      return null;
    }
    return { agent, token };
  };

  app.post<{ Params: WorkspaceParams }>(
    '/v1/workspaces/:workspace/evaluate',
    async (request, reply) => {
      const admitted = await admit(bearerToken(request), request.params, reply);
      if (admitted === null) return reply;

      const body = readEvaluateRequest(request.body);
      if (body === null) {
        return reply.code(400).send({ error: '"action" is required' });
      }
      return organization.evaluate(admitted.token, admitted.agent, body);
    },
  );

  app.post<{ Params: WorkspaceParams }>(
    '/v1/workspaces/:workspace/ask/context',
    async (request, reply) => {
      const admitted = await admit(bearerToken(request), request.params, reply);
      if (admitted === null) return reply;

      const body = asRecord(request.body);
      const question = readString(body, 'question');
      if (question === undefined) {
        return reply.code(400).send({ error: '"question" is required' });
      }
      return organization.context(
        admitted.agent,
        question,
        readString(body, 'principal'),
        readNumber(body, 'limit'),
      );
    },
  );

  app.post<{ Params: WorkspaceParams }>(
    '/v1/workspaces/:workspace/ask/owner',
    async (request, reply) => {
      const admitted = await admit(bearerToken(request), request.params, reply);
      if (admitted === null) return reply;

      const subject = readString(asRecord(request.body), 'subject');
      if (subject === undefined) {
        return reply.code(400).send({ error: '"subject" is required' });
      }
      return organization.owner(admitted.agent, subject);
    },
  );

  app.post<{ Params: WorkspaceParams }>(
    '/v1/workspaces/:workspace/ask/decisions',
    async (request, reply) => {
      const admitted = await admit(bearerToken(request), request.params, reply);
      if (admitted === null) return reply;

      const topic = readString(asRecord(request.body), 'topic');
      if (topic === undefined) {
        return reply.code(400).send({ error: '"topic" is required' });
      }
      return organization.decisions(admitted.agent, topic);
    },
  );

  app.post<{ Params: WorkspaceParams }>(
    '/v1/workspaces/:workspace/ask/agents',
    async (request, reply) => {
      const admitted = await admit(bearerToken(request), request.params, reply);
      if (admitted === null) return reply;

      const action = readString(asRecord(request.body), 'action');
      if (action === undefined) {
        return reply.code(400).send({ error: '"action" is required' });
      }
      return organization.agentsFor(admitted.agent, action);
    },
  );

  app.post<{ Params: WorkspaceParams }>(
    '/v1/workspaces/:workspace/ask/precedent',
    async (request, reply) => {
      const admitted = await admit(bearerToken(request), request.params, reply);
      if (admitted === null) return reply;

      const body = asRecord(request.body);
      const action = readString(body, 'action');
      if (action === undefined) {
        return reply.code(400).send({ error: '"action" is required' });
      }
      return organization.precedent(admitted.agent, action, readNumber(body, 'limit'));
    },
  );

  app.post<{ Params: WorkspaceParams }>(
    '/v1/workspaces/:workspace/ask/can-share',
    async (request, reply) => {
      const admitted = await admit(bearerToken(request), request.params, reply);
      if (admitted === null) return reply;

      const body = asRecord(request.body);
      const factId = readString(body, 'factId');
      const recipient = readString(body, 'recipient');
      if (factId === undefined || recipient === undefined) {
        return reply.code(400).send({ error: '"factId" and "recipient" are required' });
      }
      return organization.canShare(admitted.agent, factId, recipient);
    },
  );
}

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) return {};
  return body as Record<string, unknown>;
}

function readString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Null when the body is not an evaluate request at all. */
function readEvaluateRequest(body: unknown): EvaluateRequest | null {
  const raw = asRecord(body);
  const action = readString(raw, 'action');
  if (action === undefined) return null;

  const resource = raw['resource'];
  const principal = readString(raw, 'principal');
  const amount = readNumber(raw, 'amount');
  const environment = readString(raw, 'environment');
  const reason = readString(raw, 'reason');
  const reads = raw['reads'];

  return {
    action,
    ...(isResource(resource) ? { resource } : {}),
    ...(principal === undefined ? {} : { principal }),
    ...(amount === undefined ? {} : { amount }),
    ...(environment === undefined ? {} : { environment }),
    ...(reason === undefined ? {} : { reason }),
    ...(Array.isArray(reads)
      ? { reads: reads.filter((id): id is string => typeof id === 'string') }
      : {}),
  };
}

function isResource(value: unknown): value is { type?: string; id?: string } {
  return typeof value === 'object' && value !== null;
}
