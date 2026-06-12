import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DECISION_EFFECT, RISK_LEVEL } from '@memnox/core';
import { METRIC, MetricsRegistry } from '../src/metrics';
import { buildServer, type MemnoxServer } from '../src/server';

const POLICY_YAML = `
version: 1
policies:
  - name: block-prod-deletes
    match:
      actions: ["database.delete"]
      environments: ["production"]
    decision:
      effect: block
      reason: No AI database deletion
  - name: approve-payments
    match:
      actions: ["code.modify"]
      targets: ["payment/*"]
    decision:
      effect: require_approval
      approvers: ["team-lead"]
`;

const RATE_LIMIT = 2;

describe('MetricsRegistry', () => {
  it('renders every known counter, zero-valued until it fires', () => {
    const registry = new MetricsRegistry();
    const rendered = registry.render();

    expect(rendered).toContain(`# TYPE ${METRIC.ACTIONS_TOTAL} counter`);
    expect(rendered).toContain(`${METRIC.ACTIONS_TOTAL} 0`);
    expect(registry.value(METRIC.ACTIONS_TOTAL)).toBe(0);
  });

  it('counts each label set independently', () => {
    const registry = new MetricsRegistry();
    registry.increment(METRIC.ACTIONS_TOTAL, { effect: 'allow', risk: 'low' });
    registry.increment(METRIC.ACTIONS_TOTAL, { effect: 'allow', risk: 'low' });
    registry.increment(METRIC.ACTIONS_TOTAL, { effect: 'block', risk: 'critical' });

    expect(registry.value(METRIC.ACTIONS_TOTAL, { effect: 'allow', risk: 'low' })).toBe(
      2,
    );
    expect(registry.render()).toContain(
      `${METRIC.ACTIONS_TOTAL}{effect="allow",risk="low"} 2`,
    );
    expect(registry.render()).toContain(
      `${METRIC.ACTIONS_TOTAL}{effect="block",risk="critical"} 1`,
    );
  });
});

describe('GET /v1/metrics', () => {
  let dataDir: string;
  let server: MemnoxServer;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-metrics-'));
    const policyFile = join(dataDir, 'policies.yaml');
    await writeFile(policyFile, POLICY_YAML, 'utf8');
    server = await buildServer({
      dataDir,
      policyFile,
      checkRateLimitPerMinute: RATE_LIMIT,
    });
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function registerAgent(): Promise<string> {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { name: 'claude-code', kind: 'claude-code' },
    });
    return (response.json() as { token: string }).token;
  }

  it('serves Prometheus text', async () => {
    const response = await server.app.inject({ method: 'GET', url: '/v1/metrics' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain(`# HELP ${METRIC.ACTIONS_TOTAL}`);
    expect(response.body).toContain(`# TYPE ${METRIC.APPROVALS_TOTAL} counter`);
  });

  it('counts decisions by effect and risk level', async () => {
    const token = await registerAgent();
    await server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${token}` },
      payload: { action: 'database.delete', target: 'users', environment: 'production' },
    });

    expect(
      server.metrics.value(METRIC.ACTIONS_TOTAL, {
        effect: DECISION_EFFECT.BLOCK,
        risk: RISK_LEVEL.CRITICAL,
      }),
    ).toBe(1);
    const response = await server.app.inject({ method: 'GET', url: '/v1/metrics' });
    expect(response.body).toContain(
      `${METRIC.ACTIONS_TOTAL}{effect="${DECISION_EFFECT.BLOCK}",risk="${RISK_LEVEL.CRITICAL}"} 1`,
    );
  });

  it('counts pending approvals and rate-limit rejections', async () => {
    const token = await registerAgent();
    const check = async (): Promise<void> => {
      await server.app.inject({
        method: 'POST',
        url: '/v1/actions/check',
        headers: { authorization: `Bearer ${token}` },
        payload: { action: 'code.modify', target: 'payment/checkout.ts' },
      });
    };
    await check();
    expect(server.metrics.value(METRIC.APPROVALS_TOTAL, { state: 'pending' })).toBe(1);

    for (let attempt = 0; attempt <= RATE_LIMIT; attempt += 1) await check();
    expect(server.metrics.value(METRIC.RATE_LIMIT_REJECTIONS_TOTAL)).toBeGreaterThan(0);
  });

  it('requires the viewer role when the runtime is secured', async () => {
    const secured = await buildServer({ dataDir, adminToken: 'admin-secret' });
    expect(
      (await secured.app.inject({ method: 'GET', url: '/v1/metrics' })).statusCode,
    ).toBe(401);
    await secured.app.close();
  });
});
