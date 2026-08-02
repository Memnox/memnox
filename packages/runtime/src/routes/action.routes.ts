import type { FastifyInstance } from 'fastify';
import type {
  ActionRequest,
  ExecutionMeasurement,
  ExecutionOutcomeReport,
} from '@memnox/core';
import { EXECUTION_STATUS, type ExecutionStatus } from '@memnox/core';
import { METRIC } from '../metrics';
import { hashToken } from '../token';
import { bearerToken, type RouteContext } from './route-context';

const RATE_WINDOW_S = 60;
const RATE_KEY_HASH_LENGTH = 16;
/** Key by token hash so raw credentials never become counter keys. */
const rateKey = (token: string): string =>
  `check:${hashToken(token).slice(0, RATE_KEY_HASH_LENGTH)}`;
const certRateKey = (agentId: string): string => `check:cert:${agentId}`;

/** The hot path: agents ask for a decision before acting. */
export function registerActionRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.post('/v1/actions/check', async (request, reply) => {
    const token = bearerToken(request);
    // Bearer token wins; a verified client cert is the mTLS fallback identity.
    const certAgent =
      !token && ctx.resolveCertAgent ? await ctx.resolveCertAgent(request) : null;
    if (!token && !certAgent) return reply.code(401).send({ error: 'unauthorized' });
    const allowed = await ctx.rateLimiter.allow(
      token ? rateKey(token) : certRateKey(certAgent ? certAgent.id : ''),
      ctx.config.checkRateLimitPerMinute,
      RATE_WINDOW_S,
    );
    if (!allowed) {
      ctx.metrics.increment(METRIC.RATE_LIMIT_REJECTIONS_TOTAL);
      return reply.code(429).send({ error: 'rate limit exceeded — slow down' });
    }
    const body = request.body as Partial<ActionRequest> | undefined;
    if (!body || typeof body.action !== 'string') {
      return reply.code(400).send({ error: '"action" is required' });
    }
    return token
      ? ctx.gateway.authorize(token, body as ActionRequest)
      : ctx.gateway.authorizeAgent(certAgent, body as ActionRequest);
  });

  /** Closes the loop: what the agent did after being allowed to act. */
  app.post('/v1/actions/outcome', async (request, reply) => {
    const token = bearerToken(request);
    if (!token) return reply.code(401).send({ error: 'unauthorized' });

    const body = request.body as Partial<ExecutionOutcomeReport> | undefined;
    if (!body || typeof body.decisionEventId !== 'string') {
      return reply.code(400).send({ error: '"decisionEventId" is required' });
    }
    if (!body.action || typeof body.action !== 'string') {
      return reply.code(400).send({ error: '"action" is required' });
    }
    if (!isExecutionStatus(body.status)) {
      return reply
        .code(400)
        .send({ error: `"status" must be one of: ${VALID_STATUSES.join(', ')}` });
    }

    const measurements = parseMeasurements(body.measurements);
    if (measurements === null) {
      return reply
        .code(400)
        .send({ error: '"measurements" must be [{ name, value, unit? }]' });
    }

    const recorded = await ctx.gateway.recordOutcome(token, {
      ...body,
      status: body.status,
      rolledBack: body.rolledBack === true,
      ...(measurements.length > 0 ? { measurements } : {}),
    } as ExecutionOutcomeReport);
    if (!recorded) return reply.code(401).send({ error: 'unauthorized' });
    return reply.code(202).send({ recorded: true });
  });
}

const VALID_STATUSES: readonly ExecutionStatus[] = Object.values(EXECUTION_STATUS);

function isExecutionStatus(value: unknown): value is ExecutionStatus {
  return typeof value === 'string' && VALID_STATUSES.includes(value as ExecutionStatus);
}

/**
 * Caller-supplied numbers, so every field is checked rather than trusted.
 * Absent means "nothing measured" ([]); a malformed list is rejected (null)
 * instead of silently dropped — a caller that meant to testify should hear so.
 */
function parseMeasurements(value: unknown): ExecutionMeasurement[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;

  const measurements: ExecutionMeasurement[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { name, value: reading, unit } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || name.length === 0) return null;
    if (typeof reading !== 'number' || !Number.isFinite(reading)) return null;
    if (unit !== undefined && typeof unit !== 'string') return null;
    measurements.push({ name, value: reading, ...(unit === undefined ? {} : { unit }) });
  }
  return measurements;
}
