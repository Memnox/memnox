import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Capability, Lease } from '@memnox/core';
import { FRAME_KIND, type Frame } from '@memnox/ledger';
import { buildServer, type MemnoxServer } from '../src/server';

interface LineageReport {
  lineage: { correlationId: string; hops: { method: string; actorKind: string }[] };
  confidence: number;
  unjoined: string[];
}

describe('the flight recorder', () => {
  let dataDir: string;
  let server: MemnoxServer;
  let token: string;
  let agentId: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-frames-'));
    server = await buildServer({ dataDir });
    const registration = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { name: 'claude-code', kind: 'claude-code' },
    });
    const body = registration.json() as { agent: { id: string }; token: string };
    token = body.token;
    agentId = body.agent.id;
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const post = (payload: Record<string, unknown>, bearer = token) =>
    server.app.inject({
      method: 'POST',
      url: '/v1/frames',
      headers: { authorization: `Bearer ${bearer}` },
      payload,
    });

  const timeline = async (sessionId: string): Promise<Frame[]> =>
    (
      await server.app.inject({
        method: 'GET',
        url: `/v1/sessions/${sessionId}/frames`,
      })
    ).json() as Frame[];

  it('records a tool call a seam saw, attributed to the token’s agent', async () => {
    const response = await post({
      sessionId: 'ses_1',
      kind: FRAME_KIND.TOOL_CALL,
      summary: 'github.get_issue',
      payloadDigest: 'abc123',
    });

    expect(response.statusCode).toBe(201);
    expect((response.json() as Frame).agentId).toBe(agentId);
  });

  it('builds one session into one timeline, in the order things happened', async () => {
    await post({ sessionId: 'ses_1', kind: FRAME_KIND.TOOL_CALL, summary: 'call' });
    await post({ sessionId: 'ses_1', kind: FRAME_KIND.RESULT, summary: 'result' });
    await post({ sessionId: 'ses_2', kind: FRAME_KIND.TOOL_CALL, summary: 'other' });

    const frames = await timeline('ses_1');
    expect(frames.map((frame) => frame.kind)).toEqual([
      FRAME_KIND.TOOL_CALL,
      FRAME_KIND.RESULT,
    ]);
  });

  /** A ledger holding what an agent read would be the thing worth stealing. */
  it('takes a digest and never a payload', async () => {
    const secret = ['AKIA', 'EXAMPLEKEY'].join('');
    await post({
      sessionId: 'ses_1',
      kind: FRAME_KIND.TOOL_CALL,
      summary: 'filesystem.read /srv/.env',
      payloadDigest: 'd41d8cd98f00b204',
    });

    const written = JSON.stringify(await timeline('ses_1'));
    expect(written).not.toContain(secret);
    expect(written).toContain('d41d8cd98f00b204');
  });

  it('will not take a verdict frame, which is the gateway’s to write', async () => {
    const response = await post({
      sessionId: 'ses_1',
      kind: FRAME_KIND.VERDICT,
      summary: 'allow',
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses an unknown token rather than recording an unattributable frame', async () => {
    expect(
      (await post({ sessionId: 's', kind: 'tool_call', summary: 'x' }, 'nope'))
        .statusCode,
    ).toBe(401);
  });

  it('refuses a summary long enough to be a payload in disguise', async () => {
    const response = await post({
      sessionId: 'ses_1',
      kind: FRAME_KIND.TOOL_CALL,
      summary: 'x'.repeat(5_000),
    });
    expect(response.statusCode).toBe(400);
  });

  /** A session that shows what was decided and never what followed is half a record. */
  it('writes a side-effect frame when an outcome is reported', async () => {
    const decision = (
      await server.app.inject({
        method: 'POST',
        url: '/v1/actions/check',
        headers: { authorization: `Bearer ${token}` },
        payload: { action: 'code.modify', target: 'src/a.ts', sessionId: 'ses_1' },
      })
    ).json() as { eventId: string };

    await server.app.inject({
      method: 'POST',
      url: '/v1/actions/outcome',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        decisionEventId: decision.eventId,
        action: 'code.modify',
        target: 'src/a.ts',
        status: 'succeeded',
        sessionId: 'ses_1',
      },
    });

    const frames = await timeline('ses_1');
    expect(frames.map((frame) => frame.kind)).toContain(FRAME_KIND.SIDE_EFFECT);
  });

  it('writes a capability frame when a lease is issued', async () => {
    const capability = (
      await server.app.inject({
        method: 'POST',
        url: '/v1/capabilities',
        payload: { agentId, operation: 'refund.create', scope: {}, ttlSeconds: 300 },
      })
    ).json() as Capability;

    const issued = await server.app.inject({
      method: 'POST',
      url: '/v1/leases',
      headers: { authorization: `Bearer ${token}` },
      payload: { capabilityId: capability.id, target: 'cus_1', sessionId: 'ses_1' },
    });
    expect(issued.statusCode).toBe(201);

    const frames = await timeline('ses_1');
    const capabilityFrame = frames.find((frame) => frame.kind === FRAME_KIND.CAPABILITY);
    // The ledger holds why an agent held a credential and for how long.
    expect(capabilityFrame?.summary).toContain('refund.create');
    expect(capabilityFrame?.decisionId).toBe((issued.json() as Lease).decisionId);
  });
});

describe('lineage', () => {
  let dataDir: string;
  let server: MemnoxServer;
  let token: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-lineage-'));
    server = await buildServer({ dataDir });
    token = (
      (
        await server.app.inject({
          method: 'POST',
          url: '/v1/agents',
          payload: { name: 'claude-code', kind: 'claude-code' },
        })
      ).json() as { token: string }
    ).token;
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const report = async (sessionId: string): Promise<LineageReport> =>
    (
      await server.app.inject({
        method: 'GET',
        url: `/v1/sessions/${sessionId}/lineage`,
      })
    ).json() as LineageReport;

  it('marks a hop that carried the id as propagated, at full confidence', async () => {
    await server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${token}` },
      payload: { action: 'code.read', target: 'src/a.ts', sessionId: 'ses_1' },
    });

    const lineage = await report('ses_1');
    expect(lineage.lineage.hops).toHaveLength(1);
    expect(lineage.lineage.hops[0]?.method).toBe('propagated');
    expect(lineage.confidence).toBe(1);
  });

  /** An inferred hop pretending to be a propagated one is worse than a gap. */
  it('marks a frame with no verdict behind it as inferred, and names it', async () => {
    await server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${token}` },
      payload: { action: 'code.read', sessionId: 'ses_1' },
    });
    await server.app.inject({
      method: 'POST',
      url: '/v1/frames',
      headers: { authorization: `Bearer ${token}` },
      payload: { sessionId: 'ses_1', kind: FRAME_KIND.RESULT, summary: 'orphan result' },
    });

    const lineage = await report('ses_1');
    expect(lineage.lineage.hops.map((hop) => hop.method)).toContain('inferred');
    expect(lineage.confidence).toBeLessThan(1);
    expect(lineage.unjoined.join(' ')).toContain('orphan result');
  });

  it('reads an empty session as empty, not as a broken chain', async () => {
    const lineage = await report('ses_nothing');
    expect(lineage.lineage.hops).toEqual([]);
    expect(lineage.confidence).toBe(0);
  });
});
