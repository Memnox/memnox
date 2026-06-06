import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APPROVAL_STATUS, DECISION_EFFECT } from '@memnox/core';
import { buildServer, type MemnoxServer } from '../src/server';

const POLICY_YAML = `
version: 1
policies:
  - name: production-deploy-approval
    match:
      actions: ["deploy.*"]
      environments: ["production"]
    decision:
      effect: require_approval
      approvers: ["eng-lead"]
`;

let dataDir: string;
let server: MemnoxServer;

/** Registers an agent and drives it into a pending approval. */
async function raiseApproval(): Promise<{ token: string; approvalId: string }> {
  const registration = await server.app.inject({
    method: 'POST',
    url: '/v1/agents',
    payload: { name: 'claude-code', kind: 'claude-code' },
  });
  const { token } = registration.json() as { token: string };

  const check = await server.app.inject({
    method: 'POST',
    url: '/v1/actions/check',
    headers: { authorization: `Bearer ${token}` },
    payload: { action: 'deploy.api', environment: 'production' },
  });
  const decision = check.json() as { effect: string; approvalId: string };
  expect(decision.effect).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
  return { token, approvalId: decision.approvalId };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'memnox-approval-'));
  const policyFile = join(dataDir, 'policies.yaml');
  await writeFile(policyFile, POLICY_YAML, 'utf8');
  server = await buildServer({ dataDir, policyFile });
});

afterEach(async () => {
  await server.app.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('GET /v1/approvals/:id', () => {
  it('lets the agent that raised it poll its own approval', async () => {
    const { token, approvalId } = await raiseApproval();

    const response = await server.app.inject({
      method: 'GET',
      url: `/v1/approvals/${approvalId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const approval = response.json() as { id: string; status: string };
    expect(approval.id).toBe(approvalId);
    expect(approval.status).toBe(APPROVAL_STATUS.PENDING);
  });

  it('reflects the resolution once a human approves', async () => {
    const { token, approvalId } = await raiseApproval();
    await server.app.inject({
      method: 'POST',
      url: `/v1/approvals/${approvalId}`,
      payload: { approved: true, resolvedBy: 'dana' },
    });

    const response = await server.app.inject({
      method: 'GET',
      url: `/v1/approvals/${approvalId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    const approval = response.json() as { status: string; resolvedBy: string };
    expect(approval.status).toBe(APPROVAL_STATUS.APPROVED);
    expect(approval.resolvedBy).toBe('dana');
  });

  // Only meaningful once an admin token is set: without one the runtime is open,
  // exactly like GET /v1/approvals and every other read route.
  it('403s an agent asking about another agent’s approval, once secured', async () => {
    const { approvalId } = await raiseApproval();
    const other = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { name: 'other-bot', kind: 'custom' },
    });
    const { token: otherToken } = other.json() as { token: string };

    const secured = await buildServer({ dataDir, adminToken: 'admin-secret' });
    try {
      const response = await secured.app.inject({
        method: 'GET',
        url: `/v1/approvals/${approvalId}`,
        headers: { authorization: `Bearer ${otherToken}` },
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await secured.app.close();
    }
  });

  it('404s an approval that does not exist', async () => {
    const { token } = await raiseApproval();

    const response = await server.app.inject({
      method: 'GET',
      url: '/v1/approvals/apr_missing',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(404);
  });

  it('401s an unknown token', async () => {
    const { approvalId } = await raiseApproval();
    const secured = await buildServer({ dataDir, adminToken: 'admin-secret' });
    try {
      const response = await secured.app.inject({
        method: 'GET',
        url: `/v1/approvals/${approvalId}`,
        headers: { authorization: 'Bearer not-a-real-token' },
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await secured.app.close();
    }
  });

  it('lets an admin token read any approval', async () => {
    const { approvalId } = await raiseApproval();
    const secured = await buildServer({ dataDir, adminToken: 'admin-secret' });
    try {
      const response = await secured.app.inject({
        method: 'GET',
        url: `/v1/approvals/${approvalId}`,
        headers: { authorization: 'Bearer admin-secret' },
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await secured.app.close();
    }
  });
});

describe('GET /v1/agents/:id', () => {
  it('returns one agent with its trust score and never its token hash', async () => {
    const registration = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { name: 'claude-code', kind: 'claude-code' },
    });
    const { agent } = registration.json() as { agent: { id: string } };

    const response = await server.app.inject({
      method: 'GET',
      url: `/v1/agents/${agent.id}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body['id']).toBe(agent.id);
    expect(body['trustScore']).toBeTypeOf('number');
    expect(body['tokenHash']).toBeUndefined();
  });

  it('404s an agent that does not exist', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: '/v1/agents/agt_missing',
    });

    expect(response.statusCode).toBe(404);
  });
});
