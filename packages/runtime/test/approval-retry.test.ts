import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DECISION_EFFECT, type Decision } from '@memnox/core';
import { buildServer, type MemnoxServer } from '../src/server';

const POLICY = `
version: 1
policies:
  - name: auth-needs-approval
    match:
      actions: ["file.write"]
      targets: ["*auth*"]
    decision:
      effect: require_approval
      approvers: ["security"]
`;

/**
 * The editor-hook loop. A hook builds its request from a tool call and has
 * nowhere to carry an approval id, so it always retries the bare action. Before
 * grants were claimable by fingerprint, that retry raised a fresh hold every
 * time and an approved action could never proceed.
 */
describe('retry after approval', () => {
  let dataDir: string;
  let server: MemnoxServer;
  let token: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-retry-'));
    const policyFile = join(dataDir, 'policies.yaml');
    await writeFile(policyFile, POLICY, 'utf8');
    server = await buildServer({ dataDir, policyFile });
    const registration = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { name: 'editor', kind: 'custom' },
    });
    token = (registration.json() as { token: string }).token;
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Exactly what a hook sends: the action, and never an approval id. */
  const attempt = async (target = 'src/auth/session.ts'): Promise<Decision> => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${token}` },
      payload: { action: 'file.write', target },
    });
    return response.json() as Decision;
  };

  const approve = async (id: string): Promise<void> => {
    await server.app.inject({
      method: 'POST',
      url: `/v1/approvals/${id}`,
      payload: { approved: true, resolvedBy: 'dana' },
    });
  };

  it('lets the bare retry through once a human has granted it', async () => {
    const first = await attempt();
    expect(first.effect).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);

    await approve(first.approvalId ?? '');
    const retry = await attempt();

    expect(retry.effect).toBe(DECISION_EFFECT.ALLOW);
    expect(retry.reason).toContain('dana');
    expect(retry.approvalId).toBe(first.approvalId);
  });

  it('spends the grant, so a second attempt needs a new one', async () => {
    const first = await attempt();
    await approve(first.approvalId ?? '');
    await attempt();

    const third = await attempt();

    expect(third.effect).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
    expect(third.approvalId).not.toBe(first.approvalId);
  });

  it('does not let a grant authorize a different target', async () => {
    const first = await attempt('src/auth/session.ts');
    await approve(first.approvalId ?? '');

    const other = await attempt('src/auth/login.ts');

    expect(other.effect).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
    expect(other.approvalId).not.toBe(first.approvalId);
  });

  it('still blocks while the approval is only pending', async () => {
    const first = await attempt();
    const retry = await attempt();

    expect(retry.effect).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
    // The same open hold is reused rather than a second one being raised.
    expect(retry.approvalId).toBe(first.approvalId);
  });

  it('keeps a denial a denial on retry', async () => {
    const first = await attempt();
    await server.app.inject({
      method: 'POST',
      url: `/v1/approvals/${first.approvalId}`,
      payload: { approved: false, resolvedBy: 'dana' },
    });

    const retry = await attempt();

    expect(retry.effect).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
    expect(retry.approvalId).not.toBe(first.approvalId);
  });
});
