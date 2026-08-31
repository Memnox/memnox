import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Capability, Lease } from '@memnox/core';
import { buildServer, type MemnoxServer } from '../src/server';

describe('the broker, over the wire', () => {
  let dataDir: string;
  let server: MemnoxServer;
  let token: string;
  let agentId: string;

  const start = async (): Promise<void> => {
    server = await buildServer({ dataDir });
  };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-leases-'));
    await start();
    const registration = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { name: 'refunds-bot', kind: 'custom' },
    });
    const body = registration.json() as { agent: { id: string }; token: string };
    token = body.token;
    agentId = body.agent.id;
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const grant = (over: Record<string, unknown> = {}) =>
    server.app.inject({
      method: 'POST',
      url: '/v1/capabilities',
      payload: {
        agentId,
        operation: 'refund.create',
        scope: { customer: 'cus_1' },
        ttlSeconds: 600,
        ...over,
      },
    });

  const lease = (payload: Record<string, unknown>, bearer = token) =>
    server.app.inject({
      method: 'POST',
      url: '/v1/leases',
      headers: { authorization: `Bearer ${bearer}` },
      payload,
    });

  it('grants a capability by operation, never by secret', async () => {
    const response = await grant();
    expect(response.statusCode).toBe(201);

    const capability = response.json() as Capability;
    expect(capability.operation).toBe('refund.create');
    expect(JSON.stringify(capability)).not.toContain('key');
  });

  it('exchanges a request for a short lease', async () => {
    const capability = (await grant()).json() as Capability;

    const response = await lease({
      capabilityId: capability.id,
      target: 'cus_1/ord_9',
      scope: { customer: 'cus_1' },
    });
    expect(response.statusCode).toBe(201);

    const issued = response.json() as Lease;
    expect(issued.agentId).toBe(agentId);
    // Every lease is a decision, so the ledger holds why a credential was held.
    expect(issued.decisionId).toBeDefined();
    expect(Date.parse(issued.expiresAt)).toBeGreaterThan(Date.parse(issued.issuedAt));
  });

  it('refuses a scope wider than the capability allows', async () => {
    const capability = (await grant()).json() as Capability;
    const response = await lease({
      capabilityId: capability.id,
      target: 'cus_2/ord_1',
      scope: { customer: 'cus_2' },
    });

    expect(response.statusCode).toBe(403);
    expect((response.json() as { reason: string }).reason).toContain('wider');
  });

  it('refuses a capability belonging to another agent', async () => {
    const other = (
      await server.app.inject({
        method: 'POST',
        url: '/v1/agents',
        payload: { name: 'other-bot', kind: 'custom' },
      })
    ).json() as { token: string };
    const capability = (await grant()).json() as Capability;

    const response = await lease(
      { capabilityId: capability.id, target: 'cus_1', scope: { customer: 'cus_1' } },
      other.token,
    );
    expect(response.statusCode).toBe(403);
  });

  it('refuses an unknown token rather than issuing an unattributable lease', async () => {
    const capability = (await grant()).json() as Capability;
    const response = await lease(
      { capabilityId: capability.id, target: 'cus_1' },
      'mnx_nonsense',
    );
    expect(response.statusCode).toBe(403);
  });

  it('counts a redemption, so an unused grant is visible as unused', async () => {
    const capability = (await grant()).json() as Capability;
    const issued = (
      await lease({
        capabilityId: capability.id,
        target: 'cus_1',
        scope: { customer: 'cus_1' },
      })
    ).json() as Lease;

    const redeemed = await server.app.inject({
      method: 'POST',
      url: `/v1/leases/${issued.id}/redeem`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect((redeemed.json() as Lease).usedCount).toBe(1);
  });

  it('will not let one agent redeem another’s lease', async () => {
    const other = (
      await server.app.inject({
        method: 'POST',
        url: '/v1/agents',
        payload: { name: 'other-bot', kind: 'custom' },
      })
    ).json() as { token: string };
    const capability = (await grant()).json() as Capability;
    const issued = (
      await lease({
        capabilityId: capability.id,
        target: 'cus_1',
        scope: { customer: 'cus_1' },
      })
    ).json() as Lease;

    const response = await server.app.inject({
      method: 'POST',
      url: `/v1/leases/${issued.id}/redeem`,
      headers: { authorization: `Bearer ${other.token}` },
    });
    expect(response.statusCode).toBe(404);
  });

  /** A restart that hands back revoked authority is the worst kind of quiet bug. */
  it('keeps grants and leases across a restart', async () => {
    const capability = (await grant()).json() as Capability;
    const issued = (
      await lease({
        capabilityId: capability.id,
        target: 'cus_1',
        scope: { customer: 'cus_1' },
      })
    ).json() as Lease;

    await server.app.close();
    await start();

    const held = (
      await server.app.inject({ method: 'GET', url: `/v1/agents/${agentId}/leases` })
    ).json() as Lease[];
    const may = (
      await server.app.inject({
        method: 'GET',
        url: `/v1/agents/${agentId}/capabilities`,
      })
    ).json() as Capability[];

    expect(held.map((each) => each.id)).toEqual([issued.id]);
    expect(may.map((each) => each.id)).toEqual([capability.id]);
  });

  it('a kill revokes what is held, and the revocation survives a restart', async () => {
    const capability = (await grant()).json() as Capability;
    await lease({
      capabilityId: capability.id,
      target: 'cus_1',
      scope: { customer: 'cus_1' },
    });

    const killed = await server.app.inject({
      method: 'POST',
      url: '/v1/containment',
      payload: { kind: 'kill', subjectId: agentId, reason: 'incident', authorId: 'me' },
    });
    expect(killed.statusCode).toBe(201);

    await server.app.close();
    await start();

    const held = (
      await server.app.inject({ method: 'GET', url: `/v1/agents/${agentId}/leases` })
    ).json() as Lease[];
    expect(held[0]?.revokedAt).toBeDefined();
  });

  it('refuses a grant with no operation to ask by', async () => {
    expect((await grant({ operation: '' })).statusCode).toBe(400);
    expect((await grant({ agentId: '' })).statusCode).toBe(400);
    expect((await grant({ scope: 'everything' })).statusCode).toBe(400);
    expect((await grant({ ttlSeconds: -1 })).statusCode).toBe(400);
  });
});
