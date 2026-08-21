import type { FastifyInstance } from 'fastify';
import { API_ROLE, APPROVAL_STATUS } from '@memnox/core';
import { OVERRIDE_OUTCOME, RESOLVE_OUTCOME } from '../approval-service';
import { isAuthorizedFor, resolveApiPrincipal } from '../auth';
import { parseSlackInteraction, verifySlackSignature } from '../slack-interactions';
import { bearerToken, type RouteContext } from './route-context';

interface ResolveApprovalBody {
  approved?: boolean;
  resolvedBy?: string;
}

interface OverrideApprovalBody {
  reason?: string;
}

/** Humans resolving pending approvals — via API or signed Slack buttons. */
export function registerApprovalRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/v1/approvals', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
    return ctx.gateway.approvals.pending();
  });

  /** Where approvals stall: resolve times, what lapsed, and how often break-glass ran. */
  app.get('/v1/approvals/health', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
    return ctx.gateway.approvals.flowSummary();
  });

  /** Readable by an API principal or by the agent that raised it, nobody else. */
  app.get('/v1/approvals/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const approval = await ctx.gateway.approvals.findById(id);
    if (!approval) return reply.code(404).send({ error: 'approval not found' });

    const token = bearerToken(request);
    if (isAuthorizedFor(token, ctx.config, API_ROLE.VIEWER)) return approval;

    const agent = token ? await ctx.gateway.agents.resolveByToken(token) : null;
    if (!agent) return reply.code(401).send({ error: 'unauthorized' });
    if (agent.id !== approval.agentId) {
      return reply.code(403).send({ error: 'not your approval' });
    }
    return approval;
  });

  app.post('/v1/approvals/:id', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.APPROVER)) return;
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as ResolveApprovalBody;
    if (typeof body.approved !== 'boolean' || !body.resolvedBy) {
      return reply
        .code(400)
        .send({ error: '"approved" (boolean) and "resolvedBy" are required' });
    }
    const result = await ctx.gateway.approvals.resolve(
      id,
      body.approved,
      body.resolvedBy,
    );
    if (result.outcome === RESOLVE_OUTCOME.NOT_FOUND) {
      return reply.code(404).send({ error: 'approval not found' });
    }
    if (result.outcome === RESOLVE_OUTCOME.ALREADY_RESOLVED) {
      return reply.code(409).send({ error: 'approval is already resolved' });
    }
    if (result.outcome === RESOLVE_OUTCOME.EXPIRED) {
      return reply.code(409).send({
        error: 'approval lapsed before it was resolved; the agent must re-request',
      });
    }
    return result.approval;
  });

  app.post('/v1/approvals/:id/override', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.ADMIN)) return;
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as OverrideApprovalBody;
    if (typeof body.reason !== 'string' || body.reason.trim().length === 0) {
      return reply.code(400).send({ error: 'a non-empty "reason" is required' });
    }
    const resolvedBy = resolveApiPrincipal(bearerToken(request), ctx.config);
    const result = await ctx.gateway.approvals.override(id, resolvedBy, body.reason);
    if (result.outcome === OVERRIDE_OUTCOME.NOT_FOUND) {
      return reply.code(404).send({ error: 'approval not found' });
    }
    if (result.outcome === OVERRIDE_OUTCOME.NOT_PENDING) {
      return reply.code(409).send({ error: 'approval is not pending' });
    }
    if (result.outcome === OVERRIDE_OUTCOME.EXPIRED) {
      return reply.code(409).send({
        error: 'approval lapsed before it was overridden; the agent must re-request',
      });
    }
    if (result.outcome === OVERRIDE_OUTCOME.FORBIDDEN) {
      return reply.code(403).send({
        error: 'this action is irreversible and cannot be break-glass overridden',
      });
    }
    return result.approval;
  });

  if (ctx.config.slackSigningSecret) {
    registerSlackInteractions(app, ctx, ctx.config.slackSigningSecret);
  }
}

/** Approve/Deny buttons in Slack resolve approvals through this signed endpoint. */
function registerSlackInteractions(
  app: FastifyInstance,
  ctx: RouteContext,
  signingSecret: string,
): void {
  // Slack posts interactions as form-encoded; signatures are over the raw bytes.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => done(null, body),
  );

  app.post('/v1/integrations/slack/interactions', async (request, reply) => {
    const rawBody = typeof request.body === 'string' ? request.body : '';
    const timestamp = String(request.headers['x-slack-request-timestamp'] ?? '');
    const signature = String(request.headers['x-slack-signature'] ?? '');
    if (!verifySlackSignature(signingSecret, timestamp, rawBody, signature)) {
      return reply.code(401).send({ error: 'invalid Slack signature' });
    }
    const interaction = parseSlackInteraction(rawBody);
    if (!interaction) return reply.code(400).send({ error: 'unsupported interaction' });

    const result = await ctx.gateway.approvals.resolve(
      interaction.approvalId,
      interaction.approved,
      interaction.resolvedBy,
    );
    const approval = result.approval;
    if (!approval) {
      return { text: 'Approval not found — it may have been resolved already.' };
    }
    if (result.outcome === RESOLVE_OUTCOME.EXPIRED) {
      return {
        text: 'This approval lapsed before anyone acted on it. The agent has to ask again.',
      };
    }
    if (result.outcome === RESOLVE_OUTCOME.PENDING) {
      const remaining = approval.minApprovals - approval.grants.length;
      return {
        text: `Recorded ${interaction.resolvedBy}'s approval. ${remaining} more needed before the agent can proceed.`,
      };
    }
    return {
      text: `Approval ${approval.status} by ${interaction.resolvedBy}. The agent can retry the action now.`,
    };
  });
}
