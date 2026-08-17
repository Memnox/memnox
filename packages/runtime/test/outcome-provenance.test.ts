import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

/**
 * Testimony is still testimony about something. An outcome naming a decision
 * the runtime never made is a claim with no verdict behind it, and a success
 * reported against a block is an agent saying it went ahead anyway.
 */
describe('an outcome report, against the decision it names', () => {
  let dataDir: string;
  let server: MemnoxServer;
  let token: string;
  let otherToken: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-provenance-'));
    const policyFile = join(dataDir, 'policies.yaml');
    await writeFile(
      policyFile,
      [
        'version: 1',
        'policies:',
        '  - name: no-recursive-delete',
        '    match:',
        '      actions: ["shell.execute"]',
        '      targets: ["*rm -rf /*"]',
        '    decision:',
        '      effect: block',
        '      reason: Recursive force-delete is blocked for agents.',
      ].join('\n'),
      'utf8',
    );
    server = await buildServer({ dataDir, policyFile });
    token = await register('claude-code');
    otherToken = await register('other-agent');
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function register(name: string): Promise<string> {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { name, kind: 'custom' },
    });
    return (response.json() as { token: string }).token;
  }

  const check = async (payload: Record<string, unknown>, as = token): Promise<Decision> =>
    (
      await server.app.inject({
        method: 'POST',
        url: '/v1/actions/check',
        headers: { authorization: `Bearer ${as}` },
        payload,
      })
    ).json() as Decision;

  const report = (payload: Record<string, unknown>, as = token) =>
    server.app.inject({
      method: 'POST',
      url: '/v1/actions/outcome',
      headers: { authorization: `Bearer ${as}` },
      payload: {
        action: 'shell.execute',
        status: EXECUTION_STATUS.SUCCEEDED,
        ...payload,
      },
    });

  const outcomes = async (): Promise<ActionEvent[]> => {
    const events = (
      await server.app.inject({ method: 'GET', url: '/v1/audit' })
    ).json() as ActionEvent[];
    return events.filter((event) => event.action === EXECUTION_OUTCOME_ACTION);
  };

  it('refuses an id no decision was ever issued under', async () => {
    const response = await report({
      decisionEventId: '00000000-0000-0000-0000-000000000000',
    });

    expect(response.statusCode).toBe(404);
    expect(await outcomes()).toHaveLength(0);
  });

  it("refuses another agent's decision", async () => {
    const mine = await check({ action: 'file.read', target: 'a.md' });

    expect((await report({ decisionEventId: mine.eventId }, otherToken)).statusCode).toBe(
      404,
    );
  });

  it('records a success claimed against a block, and flags it', async () => {
    const blocked = await check({
      action: 'shell.execute',
      target: 'rm -rf /',
    });
    expect(blocked.effect).toBe('block');

    const response = await report({ decisionEventId: blocked.eventId });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ recorded: true, defied: true });

    const [outcome] = await outcomes();
    expect(outcome?.defiedVerdict).toBe(true);
    expect(outcome?.riskLevel).toBe(RISK_LEVEL.CRITICAL);
    expect(outcome?.reason).toContain('not allowed');
  });

  it('leaves an ordinary outcome unflagged', async () => {
    const allowed = await check({ action: 'file.read', target: 'a.md' });

    const response = await report({
      decisionEventId: allowed.eventId,
      action: 'file.read',
    });

    expect(response.json()).toEqual({ recorded: true });
    const [outcome] = await outcomes();
    expect(outcome?.defiedVerdict).toBeUndefined();
  });

  it('does not flag a failure reported against a block — that is honesty, not defiance', async () => {
    const blocked = await check({ action: 'shell.execute', target: 'rm -rf /' });

    const response = await report({
      decisionEventId: blocked.eventId,
      status: EXECUTION_STATUS.PRECONDITION_FAILED,
    });

    expect(response.json()).toEqual({ recorded: true });
  });
});
