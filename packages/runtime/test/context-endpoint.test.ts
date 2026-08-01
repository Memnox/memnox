import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DECISION_EFFECT, type ActionBriefing } from '@memnox/core';
import { buildServer, type MemnoxServer } from '../src/server';

const POLICY = `
version: 1
policies:
  - name: payment-code-approval
    match:
      actions: ["code.modify"]
      targets: ["payment/*"]
    decision:
      effect: require_approval
      reason: Payment logic changes need security review.
      approvers: ["security-team"]
`;

interface ContextResponse {
  briefing: ActionBriefing;
  text: string;
}

describe('POST /v1/context', () => {
  let dataDir: string;
  let server: MemnoxServer;
  let token: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-context-'));
    const policyFile = join(dataDir, 'policies.yaml');
    await writeFile(policyFile, POLICY, 'utf8');
    server = await buildServer({ dataDir, policyFile });
    const registration = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { name: 'coder', kind: 'custom' },
    });
    token = (registration.json() as { token: string }).token;
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const ask = async (payload: Record<string, unknown>) =>
    server.app.inject({
      method: 'POST',
      url: '/v1/context',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });

  it('answers with the constraints that govern the action', async () => {
    const response = await ask({ action: 'code.modify', target: 'payment/checkout.ts' });
    const body = response.json() as ContextResponse;

    expect(response.statusCode).toBe(200);
    expect(body.briefing.wouldBe).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
    expect(body.briefing.constraints[0]?.name).toBe('payment-code-approval');
    expect(body.text).toContain('Payment logic changes need security review.');
  });

  it('records nothing — asking is not attempting', async () => {
    await ask({ action: 'code.modify', target: 'payment/checkout.ts' });

    const events = await server.gateway.recentAuditEvents(10);
    expect(events).toHaveLength(0);
  });

  it('creates no approval', async () => {
    await ask({ action: 'code.modify', target: 'payment/checkout.ts' });

    expect(await server.gateway.approvals.pending()).toHaveLength(0);
  });

  it('reports an ungoverned action as ungoverned', async () => {
    const body = (
      await ask({ action: 'file.read', target: 'README.md' })
    ).json() as ContextResponse;

    expect(body.briefing.constraints).toHaveLength(0);
    expect(body.text).toContain('No rule your organization wrote covers this action.');
  });

  it('needs a token', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/context',
      payload: { action: 'file.read' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects a request with no action', async () => {
    expect((await ask({ target: 'x' })).statusCode).toBe(400);
  });
});
