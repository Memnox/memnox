import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APPROVAL_STATUS, DECISION_EFFECT, type Approval } from '@memnox/core';
import { buildServer, type MemnoxServer } from '../src/server';

const TWO_PERSON_POLICY = `
version: 1
policies:
  - name: production-deploy-two-person
    match:
      actions: ["deploy.service"]
      environments: ["production"]
    decision:
      effect: require_approval
      approvers: ["eng-lead", "security"]
      minApprovals: 2
`;

describe('two-person approval', () => {
  let dataDir: string;
  let server: MemnoxServer;
  let token: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-quorum-'));
    const policyFile = join(dataDir, 'policies.yaml');
    await writeFile(policyFile, TWO_PERSON_POLICY, 'utf8');
    server = await buildServer({ dataDir, policyFile });
    const registration = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { name: 'ci', kind: 'custom' },
    });
    token = (registration.json() as { token: string }).token;
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const requestDeploy = async (): Promise<string> => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${token}` },
      payload: { action: 'deploy.service', environment: 'production' },
    });
    const decision = response.json() as { effect: string; approvalId?: string };
    expect(decision.effect).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
    return decision.approvalId ?? '';
  };

  const resolve = (id: string, approved: boolean, resolvedBy: string) =>
    server.app.inject({
      method: 'POST',
      url: `/v1/approvals/${id}`,
      payload: { approved, resolvedBy },
    });

  it('stays pending after the first approval', async () => {
    const id = await requestDeploy();
    const response = await resolve(id, true, 'alice');

    const approval = response.json() as Approval;
    expect(approval.status).toBe(APPROVAL_STATUS.PENDING);
    expect(approval.grants).toHaveLength(1);
    expect(approval.minApprovals).toBe(2);
  });

  it('approves once a second person signs off', async () => {
    const id = await requestDeploy();
    await resolve(id, true, 'alice');
    const approval = (await resolve(id, true, 'bob')).json() as Approval;

    expect(approval.status).toBe(APPROVAL_STATUS.APPROVED);
    expect(approval.grants.map((grant) => grant.by)).toEqual(['alice', 'bob']);
  });

  it('will not let one person approve twice to reach the quorum', async () => {
    const id = await requestDeploy();
    await resolve(id, true, 'alice');
    const approval = (await resolve(id, true, 'alice')).json() as Approval;

    expect(approval.status).toBe(APPROVAL_STATUS.PENDING);
    expect(approval.grants).toHaveLength(1);
  });

  it('lets a single denial end it outright', async () => {
    const id = await requestDeploy();
    await resolve(id, true, 'alice');
    const approval = (await resolve(id, false, 'bob')).json() as Approval;

    expect(approval.status).toBe(APPROVAL_STATUS.DENIED);
    expect(approval.resolvedBy).toBe('bob');
  });

  it('unblocks the action only after the quorum is met', async () => {
    const id = await requestDeploy();
    await resolve(id, true, 'alice');

    const stillPending = await server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        action: 'deploy.service',
        environment: 'production',
        approvalId: id,
      },
    });
    expect(stillPending.json()).toMatchObject({
      effect: DECISION_EFFECT.REQUIRE_APPROVAL,
    });

    await resolve(id, true, 'bob');
    const allowed = await server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        action: 'deploy.service',
        environment: 'production',
        approvalId: id,
      },
    });
    expect(allowed.json()).toMatchObject({ effect: DECISION_EFFECT.ALLOW });
  });

  it('defaults to a single approver when no quorum is configured', async () => {
    const soloDir = await mkdtemp(join(tmpdir(), 'memnox-solo-'));
    const policyFile = join(soloDir, 'policies.yaml');
    await writeFile(
      policyFile,
      TWO_PERSON_POLICY.replace('      minApprovals: 2\n', ''),
      'utf8',
    );
    const solo = await buildServer({ dataDir: soloDir, policyFile });
    try {
      const registration = await solo.app.inject({
        method: 'POST',
        url: '/v1/agents',
        payload: { name: 'ci', kind: 'custom' },
      });
      const soloToken = (registration.json() as { token: string }).token;
      const check = await solo.app.inject({
        method: 'POST',
        url: '/v1/actions/check',
        headers: { authorization: `Bearer ${soloToken}` },
        payload: { action: 'deploy.service', environment: 'production' },
      });
      const { approvalId } = check.json() as { approvalId: string };

      const approval = (
        await solo.app.inject({
          method: 'POST',
          url: `/v1/approvals/${approvalId}`,
          payload: { approved: true, resolvedBy: 'alice' },
        })
      ).json() as Approval;
      expect(approval.status).toBe(APPROVAL_STATUS.APPROVED);
    } finally {
      await solo.app.close();
      await rm(soloDir, { recursive: true, force: true });
    }
  });
});
