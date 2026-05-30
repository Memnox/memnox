import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_ROLE, APPROVAL_STATUS, DECISION_EFFECT, RISK_LEVEL } from '@memnox/core';
import { buildServer, type MemnoxServer } from '../src/server';

const POLICY_YAML = `
version: 1
policies:
  - name: deploy-approval
    match:
      actions: ["deploy.*"]
      environments: ["production"]
    decision:
      effect: require_approval
      approvers: ["eng-lead"]
  - name: project-deletion-approval
    match:
      actions: ["project.delete"]
    decision:
      effect: require_approval
      approvers: ["eng-lead"]
`;

const ADMIN_KEY = 'admin-key';
const APPROVER_KEY = 'approver-key';

describe('break-glass approval override', () => {
  let dataDir: string;
  let server: MemnoxServer;
  let approvalId: string;
  let agentToken: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-override-'));
    const policyFile = join(dataDir, 'policies.yaml');
    await writeFile(policyFile, POLICY_YAML, 'utf8');
    server = await buildServer({
      dataDir,
      policyFile,
      apiKeys: [
        { token: ADMIN_KEY, role: API_ROLE.ADMIN },
        { token: APPROVER_KEY, role: API_ROLE.APPROVER },
      ],
    });

    const registration = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { name: 'claude-code', kind: 'claude-code' },
    });
    agentToken = (registration.json() as { token: string }).token;

    const check = await server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { action: 'deploy.service', target: 'api', environment: 'production' },
    });
    approvalId = (check.json() as { approvalId: string }).approvalId;
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('lets an admin override with a reason and audits it as critical', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/v1/approvals/${approvalId}/override`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { reason: 'incident 42 — deploy is the fix' },
    });
    expect(response.statusCode).toBe(200);
    const approval = response.json() as {
      status: string;
      override: boolean;
      resolvedBy: string;
    };
    expect(approval.status).toBe(APPROVAL_STATUS.APPROVED);
    expect(approval.override).toBe(true);
    expect(approval.resolvedBy.startsWith(`${API_ROLE.ADMIN}:`)).toBe(true);

    const audit = await server.app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });
    const events = audit.json() as Array<{ riskLevel: string; reason: string }>;
    const overrideEvent = events.find((event) =>
      event.reason.includes('break-glass override'),
    );
    expect(overrideEvent?.riskLevel).toBe(RISK_LEVEL.CRITICAL);
    expect(overrideEvent?.reason).toContain('incident 42');

    const retry = await server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        action: 'deploy.service',
        target: 'api',
        environment: 'production',
        approvalId,
      },
    });
    expect((retry.json() as { effect: string }).effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('rejects override without a non-empty reason', async () => {
    const missing = await server.app.inject({
      method: 'POST',
      url: `/v1/approvals/${approvalId}/override`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: {},
    });
    expect(missing.statusCode).toBe(400);

    const blank = await server.app.inject({
      method: 'POST',
      url: `/v1/approvals/${approvalId}/override`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { reason: '   ' },
    });
    expect(blank.statusCode).toBe(400);
  });

  it('rejects override from non-admin roles', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/v1/approvals/${approvalId}/override`,
      headers: { authorization: `Bearer ${APPROVER_KEY}` },
      payload: { reason: 'not my call' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns 404 for an unknown approval', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/approvals/does-not-exist/override',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { reason: 'testing' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses break-glass for irreversible actions and leaves the approval pending', async () => {
    const check = await server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { action: 'project.delete', target: 'acme' },
    });
    const irreversibleId = (check.json() as { approvalId: string }).approvalId;

    const response = await server.app.inject({
      method: 'POST',
      url: `/v1/approvals/${irreversibleId}/override`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { reason: 'incident 42 — I need this gone' },
    });
    expect(response.statusCode).toBe(403);

    const pending = await server.app.inject({
      method: 'GET',
      url: '/v1/approvals',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });
    const stillPending = (pending.json() as Array<{ id: string; status: string }>).find(
      (approval) => approval.id === irreversibleId,
    );
    expect(stillPending?.status).toBe(APPROVAL_STATUS.PENDING);
  });

  it('returns 409 when the approval is no longer pending', async () => {
    await server.app.inject({
      method: 'POST',
      url: `/v1/approvals/${approvalId}`,
      headers: { authorization: `Bearer ${APPROVER_KEY}` },
      payload: { approved: false, resolvedBy: 'eng-lead' },
    });
    const response = await server.app.inject({
      method: 'POST',
      url: `/v1/approvals/${approvalId}/override`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { reason: 'too late' },
    });
    expect(response.statusCode).toBe(409);
  });
});
