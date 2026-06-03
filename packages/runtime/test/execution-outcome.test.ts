import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXECUTION_OUTCOME_ACTION,
  EXECUTION_STATUS,
  RISK_LEVEL,
  type ActionEvent,
  type Decision,
} from '@memnox/core';
import { buildServer, type MemnoxServer } from '../src/server';

describe('POST /v1/actions/outcome', () => {
  let dataDir: string;
  let server: MemnoxServer;
  let token: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-outcome-'));
    server = await buildServer({ dataDir });
    const registration = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { name: 'claude-code', kind: 'claude-code' },
    });
    token = (registration.json() as { token: string }).token;
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const authorize = async (): Promise<Decision> => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${token}` },
      payload: { action: 'code.modify', target: 'src/a.ts' },
    });
    return response.json() as Decision;
  };

  const auditEvents = async (): Promise<ActionEvent[]> => {
    const response = await server.app.inject({ method: 'GET', url: '/v1/audit' });
    return response.json() as ActionEvent[];
  };

  it('audits a verified execution against the decision that authorized it', async () => {
    const decision = await authorize();

    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/actions/outcome',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        decisionEventId: decision.eventId,
        action: 'code.modify',
        target: 'src/a.ts',
        status: EXECUTION_STATUS.SUCCEEDED,
        rolledBack: false,
      },
    });

    expect(response.statusCode).toBe(202);
    const outcome = (await auditEvents()).find(
      (event) => event.action === EXECUTION_OUTCOME_ACTION,
    );
    expect(outcome?.riskLevel).toBe(RISK_LEVEL.LOW);
    expect(outcome?.reason).toContain(EXECUTION_STATUS.SUCCEEDED);
  });

  it('rates an unverified, un-rolled-back execution as high risk', async () => {
    const decision = await authorize();
    await server.app.inject({
      method: 'POST',
      url: '/v1/actions/outcome',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        decisionEventId: decision.eventId,
        action: 'code.modify',
        status: EXECUTION_STATUS.POSTCONDITION_FAILED,
        failedCondition: 'tests pass',
        rolledBack: false,
      },
    });

    const outcome = (await auditEvents()).find(
      (event) => event.action === EXECUTION_OUTCOME_ACTION,
    );
    expect(outcome?.riskLevel).toBe(RISK_LEVEL.HIGH);
    expect(outcome?.reason).toContain('not rolled back');
  });

  it('rates a failed rollback as critical — state is unknown', async () => {
    const decision = await authorize();
    await server.app.inject({
      method: 'POST',
      url: '/v1/actions/outcome',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        decisionEventId: decision.eventId,
        action: 'code.modify',
        status: EXECUTION_STATUS.POSTCONDITION_FAILED,
        rolledBack: false,
        rollbackError: 'force push rejected',
      },
    });

    const outcome = (await auditEvents()).find(
      (event) => event.action === EXECUTION_OUTCOME_ACTION,
    );
    expect(outcome?.riskLevel).toBe(RISK_LEVEL.CRITICAL);
    expect(outcome?.reason).toContain('rollback FAILED');
  });

  it('rejects an unknown status rather than storing it', async () => {
    const decision = await authorize();
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/actions/outcome',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        decisionEventId: decision.eventId,
        action: 'code.modify',
        status: 'probably-fine',
        rolledBack: false,
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('stamps the deciding policy version onto the decision event', async () => {
    const decision = await authorize();
    const event = (await auditEvents()).find((item) => item.id === decision.eventId);
    // Empty rule set still has a stable version, so every event is traceable.
    expect(event?.policyVersion).toMatch(/^[0-9a-f]{12}$/);
  });

  it('rejects an unauthenticated report', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/actions/outcome',
      payload: {
        decisionEventId: 'evt-1',
        action: 'code.modify',
        status: EXECUTION_STATUS.SUCCEEDED,
        rolledBack: false,
      },
    });
    expect(response.statusCode).toBe(401);
  });
});
