import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXECUTION_OUTCOME_ACTION,
  EXECUTION_STATUS,
  RISK_LEVEL,
  type ActionEvent,
  type ComplianceReport,
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
    const events = await auditEvents();
    const outcomes = events.filter((event) => event.action === EXECUTION_OUTCOME_ACTION);
    // Exactly one, or the coverage join would double-count this execution.
    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0];
    expect(outcome?.riskLevel).toBe(RISK_LEVEL.LOW);
    expect(outcome?.reason).toContain(EXECUTION_STATUS.SUCCEEDED);
    // The linkage this suite is named for: the outcome names its own decision.
    expect(outcome?.decisionEventId).toBe(decision.eventId);
    expect(outcome?.executionStatus).toBe(EXECUTION_STATUS.SUCCEEDED);
    expect(outcome?.rolledBack).toBe(false);
    expect(outcome?.rollbackFailed).toBe(false);
  });

  it('carries the reported rollback failure onto the event, not just the reason text', async () => {
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
    expect(outcome?.executionStatus).toBe(EXECUTION_STATUS.POSTCONDITION_FAILED);
    expect(outcome?.rollbackFailed).toBe(true);
  });

  it('records the measurements the caller reported', async () => {
    const decision = await authorize();
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/actions/outcome',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        decisionEventId: decision.eventId,
        action: 'database.migrate',
        status: EXECUTION_STATUS.SUCCEEDED,
        rolledBack: false,
        measurements: [
          { name: 'downtime', value: 0, unit: 's' },
          { name: 'rows', value: 1_200 },
        ],
      },
    });

    expect(response.statusCode).toBe(202);
    const outcome = (await auditEvents()).find(
      (event) => event.action === EXECUTION_OUTCOME_ACTION,
    );
    // Testimony, so it reads back as the caller's own numbers.
    expect(outcome?.reason).toContain('downtime=0s, rows=1200');
  });

  it('rejects a malformed measurement rather than dropping it', async () => {
    const decision = await authorize();
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/actions/outcome',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        decisionEventId: decision.eventId,
        action: 'database.migrate',
        status: EXECUTION_STATUS.SUCCEEDED,
        rolledBack: false,
        measurements: [{ name: 'downtime', value: 'zero' }],
      },
    });

    expect(response.statusCode).toBe(400);
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

  it('joins outcomes to decisions in the compliance report, through the store', async () => {
    const reported = await authorize();
    await authorize();
    await server.app.inject({
      method: 'POST',
      url: '/v1/actions/outcome',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        decisionEventId: reported.eventId,
        action: 'code.modify',
        target: 'src/a.ts',
        status: EXECUTION_STATUS.SUCCEEDED,
        rolledBack: false,
      },
    });

    const response = await server.app.inject({
      method: 'GET',
      url: '/v1/reports/compliance',
    });
    const { verification } = response.json() as ComplianceReport;

    // Proves the new fields survive the audit store round-trip, not just the gateway.
    expect(verification.allowed).toBe(2);
    expect(verification.reported).toBe(1);
    expect(verification.succeeded).toBe(1);
    // The unreported one was authorized moments ago, so it is still in flight —
    // nothing is owed yet, and it must not appear on the chase list.
    expect(verification.inFlight).toBe(1);
    expect(verification.unreported).toBe(0);
    expect(verification.unreportedActions).toEqual([]);
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
