import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActionEvent } from '@memnox/core';
import { buildServer, type MemnoxServer } from '../src/server';

/** Only break-glass used to be audited, so an ordinary grant left no trace. */
describe('resolving an approval', () => {
  let dataDir: string;
  let server: MemnoxServer;
  let token: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-approval-audit-'));
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
        '      minApprovals: 2',
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

  const raise = async (): Promise<string> => {
    const decision = (
      await server.app.inject({
        method: 'POST',
        url: '/v1/actions/check',
        headers: { authorization: `Bearer ${token}` },
        payload: { action: 'payment.refund', target: 'order-1', amount: 120 },
      })
    ).json() as { approvalId: string };
    return decision.approvalId;
  };

  const resolve = (id: string, approved: boolean, by: string) =>
    server.app.inject({
      method: 'POST',
      url: `/v1/approvals/${id}`,
      payload: { approved, resolvedBy: by },
    });

  const audit = async (): Promise<ActionEvent[]> =>
    (
      await server.app.inject({ method: 'GET', url: '/v1/audit?limit=100' })
    ).json() as ActionEvent[];

  it('records who granted it, and what is still outstanding', async () => {
    const id = await raise();

    await resolve(id, true, 'priya');

    const partial = (await audit()).find((event) => event.reason.includes('priya'));
    expect(partial).toBeDefined();
    expect(partial?.effect).toBe('escalate');
    expect(partial?.reason).toContain('1 of 2');
    expect(partial?.action).toBe('payment.refund');
  });

  it('records the grant that completes the quorum as an allow', async () => {
    const id = await raise();
    await resolve(id, true, 'priya');

    await resolve(id, true, 'sam');

    const completing = (await audit()).find(
      (event) => event.reason === 'approval granted by sam',
    );
    expect(completing?.effect).toBe('allow');
  });

  it('records a denial, and names who refused', async () => {
    const id = await raise();

    await resolve(id, false, 'carlos');

    const denial = (await audit()).find((event) => event.reason.includes('carlos'));
    expect(denial?.effect).toBe('withhold');
    expect(denial?.reason).toBe('approval denied by carlos');
  });

  it('keeps the chain intact across a resolution', async () => {
    const id = await raise();
    await resolve(id, true, 'priya');
    await resolve(id, true, 'sam');

    const verified = (
      await server.app.inject({ method: 'GET', url: '/v1/audit/verify' })
    ).json() as { valid: boolean };
    expect(verified.valid).toBe(true);
  });
});
