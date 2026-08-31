import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DeclaredScope, Task, TaskDeclaredBy } from '@memnox/core';
import { TASK_DECLARED_BY } from '@memnox/core';
import { bearerToken, type RouteContext } from './route-context';

const SCOPE_KEYS = [
  'paths',
  'repositories',
  'services',
  'environments',
  'resourceKinds',
] as const satisfies ReadonlyArray<keyof DeclaredScope>;

/** Intent as data: the session says what it was asked for and what that implies. */
export function registerTaskRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.post('/v1/tasks', async (request, reply) => {
    const agent = await resolveAgent(ctx, request, reply);
    if (!agent) return;

    const body = request.body as Record<string, unknown> | undefined;
    const sessionId = readString(body, 'sessionId');
    if (sessionId === undefined) {
      return reply.code(400).send({ error: '"sessionId" is required' });
    }
    const statement = readString(body, 'statement');
    if (statement === undefined) {
      return reply.code(400).send({ error: '"statement" is required' });
    }
    const declaredScope = parseScope(
      body === undefined ? undefined : body['declaredScope'],
    );
    if (declaredScope === null) {
      return reply.code(400).send({
        error: `"declaredScope" keys must be string arrays: ${SCOPE_KEYS.join(', ')}`,
      });
    }
    const declaredBy = parseDeclaredBy(
      body === undefined ? undefined : body['declaredBy'],
    );
    if (declaredBy === null) {
      return reply.code(400).send({
        error: `"declaredBy" must be one of: ${Object.values(TASK_DECLARED_BY).join(', ')}`,
      });
    }

    // One open task per session, or an agent picks whichever scope suits the
    // action it wants next, which is the whole check undone.
    const existing = await ctx.tasks.findBySession(sessionId);
    if (existing !== null && existing.endedAt === undefined) {
      return reply
        .code(409)
        .send({ error: 'this session already declared a task', taskId: existing.id });
    }

    const task: Task = {
      id: randomUUID(),
      sessionId,
      subjectId: agent.id,
      statement,
      declaredScope,
      declaredBy,
      startedAt: new Date().toISOString(),
    };
    await ctx.tasks.save(task);
    return reply.code(201).send(task);
  });

  app.get<{ Params: { id: string } }>('/v1/tasks/:id', async (request, reply) => {
    const task = await requireOwnTask(ctx, request, reply, request.params.id);
    if (!task) return;
    return task;
  });

  app.post<{ Params: { id: string } }>('/v1/tasks/:id/end', async (request, reply) => {
    const task = await requireOwnTask(ctx, request, reply, request.params.id);
    if (!task) return;
    if (task.endedAt !== undefined) return task;
    const ended: Task = { ...task, endedAt: new Date().toISOString() };
    await ctx.tasks.save(ended);
    return ended;
  });
}

async function resolveAgent(
  ctx: RouteContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ id: string } | null> {
  const token = bearerToken(request);
  if (!token) {
    await reply.code(401).send({ error: 'unauthorized' });
    return null;
  }
  const agent = await ctx.gateway.agents.resolveByToken(token);
  if (!agent) {
    await reply.code(401).send({ error: 'unauthorized' });
    return null;
  }
  return agent;
}

/** A task is its own agent's; another must not read it or declare it finished. */
async function requireOwnTask(
  ctx: RouteContext,
  request: FastifyRequest,
  reply: FastifyReply,
  id: string,
): Promise<Task | null> {
  const agent = await resolveAgent(ctx, request, reply);
  if (!agent) return null;
  const task = await ctx.tasks.findById(id);
  if (!task) {
    await reply.code(404).send({ error: 'task not found' });
    return null;
  }
  if (task.subjectId !== agent.id) {
    await reply.code(403).send({ error: 'not your task' });
    return null;
  }
  return task;
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

function parseScope(raw: unknown): DeclaredScope | null {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const scope: Record<string, string[]> = {};
  for (const key of SCOPE_KEYS) {
    const value = source[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      return null;
    }
    scope[key] = value as string[];
  }
  return scope;
}

function parseDeclaredBy(raw: unknown): TaskDeclaredBy | null {
  if (raw === undefined) return TASK_DECLARED_BY.HUMAN;
  if (typeof raw !== 'string') return null;
  const known = (Object.values(TASK_DECLARED_BY) as string[]).includes(raw);
  return known ? (raw as TaskDeclaredBy) : null;
}
