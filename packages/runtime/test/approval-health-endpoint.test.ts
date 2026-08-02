import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DECISION_EFFECT, type ApprovalFlowSummary } from '@memnox/core';
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

async function registerAgent(): Promise<string> {
  const registration = await server.app.inject({
    method: 'POST',
    url: '/v1/agents',
    payload: { name: 'claude-code', kind: 'claude-code' },
  });
  return (registration.json() as { token: string }).token;
}

async function raiseApproval(token: string): Promise<string> {
  const check = await server.app.inject({
    method: 'POST',
    url: '/v1/actions/check',
    headers: { authorization: `Bearer ${token}` },
    payload: { action: 'deploy.api', environment: 'production' },
  });
  const decision = check.json() as { effect: string; approvalId: string };
  expect(decision.effect).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
  return decision.approvalId;
}

const health = async (): Promise<ApprovalFlowSummary> => {
  const response = await server.app.inject({
    method: 'GET',
    url: '/v1/approvals/health',
  });
  expect(response.statusCode).toBe(200);
  return response.json() as ApprovalFlowSummary;
};

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'memnox-approval-health-'));
  const policyFile = join(dataDir, 'policies.yaml');
  await writeFile(policyFile, POLICY_YAML, 'utf8');
  server = await buildServer({ dataDir, policyFile });
});

afterEach(async () => {
  await server.app.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('GET /v1/approvals/health', () => {
  it('reports nothing raised without inventing a resolve time', async () => {
    const summary = await health();

    expect(summary.total).toBe(0);
    expect(summary.medianResolveMinutes).toBeNull();
  });

  it('counts a pending approval before anyone has answered it', async () => {
    await raiseApproval(await registerAgent());

    const summary = await health();

    expect(summary.total).toBe(1);
    expect(summary.pending).toBe(1);
    expect(summary.approved).toBe(0);
  });

  it('spans statuses the store only lists one at a time', async () => {
    const token = await registerAgent();
    const approvedId = await raiseApproval(token);
    await server.app.inject({
      method: 'POST',
      url: `/v1/approvals/${approvedId}`,
      payload: { approved: true, resolvedBy: 'eng-lead' },
    });

    const summary = await health();

    // The approval moved out of "pending", so a pending-only read would miss it.
    expect(summary.total).toBe(1);
    expect(summary.approved).toBe(1);
    expect(summary.pending).toBe(0);
    expect(summary.medianResolveMinutes).not.toBeNull();
    expect(summary.approverActivity).toEqual([{ approver: 'eng-lead', grants: 1 }]);
  });

  it('counts a break-glass override as an override', async () => {
    const token = await registerAgent();
    const approvalId = await raiseApproval(token);
    await server.app.inject({
      method: 'POST',
      url: `/v1/approvals/${approvalId}/override`,
      payload: { reason: 'incident bridge, production is down' },
    });

    const summary = await health();

    expect(summary.overrides).toBe(1);
  });
});
