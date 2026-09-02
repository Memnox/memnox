import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
import { buildServer, type MemnoxServer } from '../src/server';

/**
 * Three fields, all required before an agent is enrolled: the kind is the product, the
 * role is the job, the principal is the person it acts for. Policy is written about the
 * role, so swapping the product tomorrow leaves every rule about the role standing.
 */
describe('enrolling an agent', () => {
  let dataDir: string;
  let server: MemnoxServer;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-enrolment-'));
    server = await buildServer({ dataDir });
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const enrol = (payload: Record<string, unknown>) =>
    server.app.inject({ method: 'POST', url: '/v1/agents', payload });

  it('records the product, the job and the person', async () => {
    const response = await enrol({
      name: 'openclaw',
      kind: 'custom',
      role: 'release-engineer',
      principal: 'Sarah Okonkwo',
    });

    expect(response.statusCode).toBe(201);
    const { agent } = response.json() as {
      agent: { kind: string; role: string; principal: string };
    };
    expect(agent.kind).toBe('custom');
    expect(agent.role).toBe('release-engineer');
    expect(agent.principal).toBe('Sarah Okonkwo');
  });

  /* Refused rather than defaulted: an agent enrolled with no stated job produces an
     incident report naming an API key, which is the thing this exists to prevent. */
  it('refuses an agent with no stated role', async () => {
    const response = await enrol({
      name: 'openclaw',
      kind: 'custom',
      principal: 'moise',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: expect.stringContaining('role') });
  });

  it('refuses an agent with no stated principal', async () => {
    const response = await enrol({ name: 'openclaw', kind: 'custom', role: 'reviewer' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: expect.stringContaining('principal'),
    });
  });

  it('refuses a role that is only whitespace', async () => {
    const response = await enrol({
      name: 'openclaw',
      kind: 'custom',
      role: '   ',
      principal: 'moise',
    });

    expect(response.statusCode).toBe(400);
  });
});

/**
 * The point of the role: swap the product tomorrow and every rule about the job still
 * holds. A rule written about `agents` cannot do that.
 */
describe('policy written about the role', () => {
  let dataDir: string;
  let server: MemnoxServer;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-role-policy-'));
    const policyFile = join(dataDir, 'rules.yaml');
    await writeFile(
      policyFile,
      `version: 1
policies:
  - name: releases-need-review
    match:
      actions: ["deploy.*"]
      roles: ["release-engineer"]
    decision:
      effect: withhold
      reason: Releases need review.
`,
      'utf8',
    );
    server = await buildServer({ dataDir, policyFile });
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function tokenFor(kind: string, role: string): Promise<string> {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { name: `${kind}-${role}`, kind, role, principal: 'moise' },
    });
    return (response.json() as { token: string }).token;
  }

  const deploy = async (token: string): Promise<string> => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${token}` },
      payload: { action: 'deploy.service', target: 'payments' },
    });
    return (response.json() as { effect: string }).effect;
  };

  it('binds to the job, so two different products are governed alike', async () => {
    expect(await deploy(await tokenFor('claude-code', 'release-engineer'))).toBe(
      DECISION_EFFECT.WITHHOLD,
    );
    expect(await deploy(await tokenFor('custom', 'release-engineer'))).toBe(
      DECISION_EFFECT.WITHHOLD,
    );
  });

  it('leaves another job alone', async () => {
    expect(await deploy(await tokenFor('claude-code', 'docs-writer'))).toBe(
      DECISION_EFFECT.ALLOW,
    );
  });

  it('names the role on the audit event, so an incident report has a job in it', async () => {
    await deploy(await tokenFor('claude-code', 'release-engineer'));

    const audit = await server.app.inject({ method: 'GET', url: '/v1/audit' });
    const events = audit.json() as Array<{ agentRole?: string }>;
    expect(events[0]?.agentRole).toBe('release-engineer');
  });
});
