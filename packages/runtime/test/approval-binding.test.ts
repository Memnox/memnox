import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Approval } from '@memnox/core';
import { buildServer, type MemnoxServer } from '../src/server';

/** "One action" has to include the fields the rule was actually about. */
describe('what an approval is bound to', () => {
  let dataDir: string;
  let server: MemnoxServer;
  let token: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-binding-'));
    const policyFile = join(dataDir, 'policies.yaml');
    await writeFile(
      policyFile,
      [
        'version: 1',
        'policies:',
        '  - name: refund-approval',
        '    match:',
        '      actions: ["payment.refund"]',
        '    decision:',
        '      effect: escalate',
        '      reason: Issuing a refund needs a human.',
        '      approvers: ["finance-team"]',
      ].join('\n'),
      'utf8',
    );
    server = await buildServer({ dataDir, policyFile });
    const registered = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { name: 'billing-bot', kind: 'custom' },
    });
    token = (registered.json() as { token: string }).token;
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const check = async (payload: Record<string, unknown>) =>
    (
      await server.app.inject({
        method: 'POST',
        url: '/v1/actions/check',
        headers: { authorization: `Bearer ${token}` },
        payload,
      })
    ).json() as { effect: string; approvalId?: string };

  const grant = (id: string) =>
    server.app.inject({
      method: 'POST',
      url: `/v1/approvals/${id}`,
      payload: { approved: true, resolvedBy: 'finance-lead' },
    });

  it('raises a separate hold for a different amount', async () => {
    const small = await check({
      action: 'payment.refund',
      target: 'order-1',
      amount: 120,
    });
    const large = await check({
      action: 'payment.refund',
      target: 'order-1',
      amount: 4500,
    });

    expect(small.approvalId).toBeDefined();
    expect(large.approvalId).toBeDefined();
    expect(large.approvalId).not.toBe(small.approvalId);
  });

  it('does not let a grant for one amount authorize another', async () => {
    const small = await check({
      action: 'payment.refund',
      target: 'order-1',
      amount: 120,
    });
    await grant(small.approvalId as string);

    expect(
      (await check({ action: 'payment.refund', target: 'order-1', amount: 120 })).effect,
    ).toBe('allow');
    expect(
      (await check({ action: 'payment.refund', target: 'order-1', amount: 4500 })).effect,
    ).toBe('escalate');
  });

  it('separates two people asking for the same action', async () => {
    const sarah = await check({
      action: 'payment.refund',
      target: 'order-1',
      principal: 'sarah@acme.test',
    });
    await grant(sarah.approvalId as string);

    expect(
      (
        await check({
          action: 'payment.refund',
          target: 'order-1',
          principal: 'carlos@acme.test',
        })
      ).effect,
    ).toBe('escalate');
  });

  it('shows the approver what they are authorizing', async () => {
    const raised = await check({
      action: 'payment.refund',
      target: 'order-1',
      amount: 4500,
      principal: 'sarah@acme.test',
    });

    const approval = (
      await server.app.inject({
        method: 'GET',
        url: `/v1/approvals/${raised.approvalId}`,
      })
    ).json() as Approval;

    expect(approval.amount).toBe(4500);
    expect(approval.principal).toBe('sarah@acme.test');
  });
});
