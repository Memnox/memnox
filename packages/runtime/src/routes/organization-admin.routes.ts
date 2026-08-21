import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { API_ROLE } from '@memnox/core';
import {
  DEFAULT_WORKSPACE,
  STATED_KIND,
  STATED_PROVENANCE,
  type StatedKind,
  type StatedProvenance,
} from '@memnox/org-graph';
import type { DelegateInput, RecordStatedInput } from '../organization-service';
import type { RouteContext } from './route-context';

const KINDS: readonly string[] = Object.values(STATED_KIND);
const PROVENANCES: readonly string[] = Object.values(STATED_PROVENANCE);
/** Who a statement is attributed to when an admin credential records one. */
const ADMIN_AUTHOR = 'admin';

/** Entering, confirming, delegating — separate from the agent protocol. */
export function registerOrganizationAdminRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): void {
  const organization = ctx.organization;
  /** Null means the guard already answered, so the caller must stop. */
  const admittedWorkspace = (
    request: FastifyRequest,
    reply: FastifyReply,
  ): string | null => {
    const named = readString(asRecord(request.query), 'workspace') ?? DEFAULT_WORKSPACE;
    return ctx.requireWorkspace(request, reply, named) ? named : null;
  };

  app.get('/v1/organization/statements', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
    const workspace = admittedWorkspace(request, reply);
    if (workspace === null) return reply;
    return organization.listStatements(workspace);
  });

  app.post('/v1/organization/statements', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.ADMIN)) return;
    const workspace = admittedWorkspace(request, reply);
    if (workspace === null) return reply;
    const input = readStatedInput(request.body);
    if (input === null) {
      return reply
        .code(400)
        .send({ error: '"kind", "statement" and "subject" are required' });
    }
    return reply.code(201).send(await organization.record(workspace, input));
  });

  app.post<{ Params: { id: string } }>(
    '/v1/organization/statements/:id/verify',
    async (request, reply) => {
      if (!ctx.requireRole(request, reply, API_ROLE.ADMIN)) return;
      const workspace = admittedWorkspace(request, reply);
      if (workspace === null) return reply;
      const by = readString(asRecord(request.body), 'by') ?? ADMIN_AUTHOR;
      const verified = await organization.verify(workspace, request.params.id, by);
      if (verified === null) {
        return reply.code(404).send({ error: 'no such candidate statement' });
      }
      return verified;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/organization/statements/:id/reject',
    async (request, reply) => {
      if (!ctx.requireRole(request, reply, API_ROLE.ADMIN)) return;
      const workspace = admittedWorkspace(request, reply);
      if (workspace === null) return reply;
      const by = readString(asRecord(request.body), 'by') ?? ADMIN_AUTHOR;
      const rejected = await organization.reject(workspace, request.params.id, by);
      if (rejected === null) {
        return reply.code(404).send({ error: 'no such candidate statement' });
      }
      return rejected;
    },
  );

  /** Where an extraction run lands. Candidates only — the shape cannot say otherwise. */
  app.post('/v1/organization/candidates', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.ADMIN)) return;
    const workspace = admittedWorkspace(request, reply);
    if (workspace === null) return reply;
    const body = asRecord(request.body);
    const candidates = body['candidates'];
    if (!Array.isArray(candidates)) {
      return reply.code(400).send({ error: '"candidates" must be an array' });
    }
    const filed = await organization.propose(
      workspace,
      candidates as Parameters<typeof organization.propose>[1],
    );
    return reply.code(201).send(filed);
  });

  app.get('/v1/organization/authority', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.VIEWER)) return;
    const workspace = admittedWorkspace(request, reply);
    if (workspace === null) return reply;
    return organization.listGrants(workspace);
  });

  app.post('/v1/organization/authority', async (request, reply) => {
    if (!ctx.requireRole(request, reply, API_ROLE.ADMIN)) return;
    const workspace = admittedWorkspace(request, reply);
    if (workspace === null) return reply;
    const input = readDelegateInput(request.body);
    if (input === null) {
      return reply
        .code(400)
        .send({ error: '"principal" and a non-empty "actions" are required' });
    }
    return reply.code(201).send(await organization.delegate(workspace, input));
  });

  app.delete<{ Params: { id: string } }>(
    '/v1/organization/authority/:id',
    async (request, reply) => {
      if (!ctx.requireRole(request, reply, API_ROLE.ADMIN)) return;
      const workspace = admittedWorkspace(request, reply);
      if (workspace === null) return reply;
      const revoked = await organization.revokeGrant(workspace, request.params.id);
      if (!revoked) return reply.code(404).send({ error: 'no such grant' });
      return reply.code(204).send();
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

function readStrings(body: Record<string, unknown>, field: string): string[] | undefined {
  const value = body[field];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === 'string');
  return strings.length === 0 ? undefined : strings;
}

function readStatedInput(body: unknown): RecordStatedInput | null {
  const raw = asRecord(body);
  const kind = readString(raw, 'kind');
  const statement = readString(raw, 'statement');
  const subject = readString(raw, 'subject');
  if (kind === undefined || !KINDS.includes(kind)) return null;
  if (statement === undefined || subject === undefined) return null;

  const provenance = readString(raw, 'provenance');
  const limit = readNumber(raw, 'limit');
  return {
    kind: kind as StatedKind,
    statement,
    subject,
    recordedBy: readString(raw, 'recordedBy') ?? ADMIN_AUTHOR,
    ...(readString(raw, 'principal') === undefined
      ? {}
      : { principal: readString(raw, 'principal') }),
    ...(readString(raw, 'capability') === undefined
      ? {}
      : { capability: readString(raw, 'capability') }),
    ...(limit === undefined ? {} : { limit }),
    ...(readString(raw, 'object') === undefined
      ? {}
      : { object: readString(raw, 'object') }),
    ...(readString(raw, 'sourceRef') === undefined
      ? {}
      : { sourceRef: readString(raw, 'sourceRef') }),
    ...(readStrings(raw, 'clearance') === undefined
      ? {}
      : { clearance: readStrings(raw, 'clearance') }),
    ...(readString(raw, 'effectiveFrom') === undefined
      ? {}
      : { effectiveFrom: readString(raw, 'effectiveFrom') }),
    ...(readString(raw, 'effectiveTo') === undefined
      ? {}
      : { effectiveTo: readString(raw, 'effectiveTo') }),
    ...(readString(raw, 'supersedes') === undefined
      ? {}
      : { supersedes: readString(raw, 'supersedes') }),
    ...(provenance === undefined || !PROVENANCES.includes(provenance)
      ? {}
      : { provenance: provenance as StatedProvenance }),
  };
}

function readDelegateInput(body: unknown): DelegateInput | null {
  const raw = asRecord(body);
  const principal = readString(raw, 'principal');
  const actions = readStrings(raw, 'actions');
  if (principal === undefined || actions === undefined) return null;

  const limit = readNumber(raw, 'limit');
  const overLimit = readString(raw, 'overLimit');
  return {
    principal,
    actions,
    grantedBy: readString(raw, 'grantedBy') ?? ADMIN_AUTHOR,
    ...(readStrings(raw, 'agents') === undefined
      ? {}
      : { agents: readStrings(raw, 'agents') }),
    ...(limit === undefined ? {} : { limit }),
    ...(readStrings(raw, 'approvers') === undefined
      ? {}
      : { approvers: readStrings(raw, 'approvers') }),
    ...(readString(raw, 'expiresAt') === undefined
      ? {}
      : { expiresAt: readString(raw, 'expiresAt') }),
    /* Only two values are meaningful and allow is not one of them: a ceiling
       that widens on being exceeded is not a ceiling. Anything else falls back
       to asking a person. */
    ...(overLimit === 'block' ? { overLimit: 'block' as const } : {}),
  };
}
