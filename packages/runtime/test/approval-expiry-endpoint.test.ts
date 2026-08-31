import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { API_ROLE, APPROVAL_STATUS } from '@memnox/core';
import { PostgresApprovalStore, type SqlClient } from '@memnox/postgres';
import { buildServer, type MemnoxServer } from '../src/server';

const POLICY_YAML = `
version: 1
policies:
  - name: deploy-approval
    match:
      actions: ["deploy.*"]
      environments: ["production"]
    decision:
      effect: escalate
      approvers: ["eng-lead"]
`;

const ADMIN_KEY = 'admin-key';
const APPROVER_KEY = 'approver-key';
const LONG_PAST = '2020-01-01T00:00:00.000Z';

/** The real Postgres adapter filters nothing, so a lapsed hold surfaces here. */
describe('lapsed approvals over HTTP', () => {
  let dataDir: string;
  let server: MemnoxServer;
  let sql: SqlClient;
  let agentToken: string;
  let approvalId: string;

  const deploy = (approval?: string) =>
    server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        action: 'deploy.service',
        target: 'api',
        environment: 'production',
        ...(approval === undefined ? {} : { approvalId: approval }),
      },
    });

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-lapsed-'));
    const policyFile = join(dataDir, 'policies.yaml');
    await writeFile(policyFile, POLICY_YAML, 'utf8');
    const { Pool } = newDb().adapters.createPg() as { Pool: new () => SqlClient };
    sql = new Pool();
    server = await buildServer(
      {
        dataDir,
        policyFile,
        apiKeys: [
          { token: ADMIN_KEY, role: API_ROLE.ADMIN },
          { token: APPROVER_KEY, role: API_ROLE.APPROVER },
        ],
      },
      { sql },
    );

    const registration = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { name: 'claude-code', kind: 'claude-code' },
    });
    agentToken = (registration.json() as { token: string }).token;
    approvalId = ((await deploy()).json() as { approvalId: string }).approvalId;
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Ages the hold in SQL rather than waiting out the seven-day TTL. */
  async function lapse(): Promise<void> {
    const store = new PostgresApprovalStore(sql);
    const approval = await store.findById(approvalId);
    if (approval === null) throw new Error('expected an approval to lapse');
    await store.save({ ...approval, expiresAt: LONG_PAST });
  }

  it('refuses to resolve one, and says why', async () => {
    await lapse();
    const response = await server.app.inject({
      method: 'POST',
      url: `/v1/approvals/${approvalId}`,
      headers: { authorization: `Bearer ${APPROVER_KEY}` },
      payload: { approved: true, resolvedBy: 'eng-lead' },
    });

    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: string }).error).toContain('lapsed');
  });

  it('refuses to break the glass on one', async () => {
    await lapse();
    const response = await server.app.inject({
      method: 'POST',
      url: `/v1/approvals/${approvalId}/override`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { reason: 'incident 42' },
    });

    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: string }).error).toContain('lapsed');
  });

  it('drops it from the approver queue and retires it', async () => {
    await lapse();
    await server.app.inject({
      method: 'POST',
      url: `/v1/approvals/${approvalId}`,
      headers: { authorization: `Bearer ${APPROVER_KEY}` },
      payload: { approved: true, resolvedBy: 'eng-lead' },
    });

    const queue = await server.app.inject({
      method: 'GET',
      url: '/v1/approvals',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(queue.json()).toHaveLength(0);

    const retired = await new PostgresApprovalStore(sql).findById(approvalId);
    expect(retired?.status).toBe(APPROVAL_STATUS.EXPIRED);
  });

  it('hands the agent a fresh hold when it asks again', async () => {
    await lapse();
    const retry = await deploy();

    const next = (retry.json() as { approvalId: string }).approvalId;
    expect(next).toBeTruthy();
    expect(next).not.toBe(approvalId);
  });

  it('still resolves a hold that has not lapsed', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/v1/approvals/${approvalId}`,
      headers: { authorization: `Bearer ${APPROVER_KEY}` },
      payload: { approved: true, resolvedBy: 'eng-lead' },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { status: string }).status).toBe(APPROVAL_STATUS.APPROVED);
  });
});
