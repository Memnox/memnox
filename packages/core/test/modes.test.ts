import { describe, expect, it } from 'vitest';
import { LocalGate } from '../src/gate/local-gate';
import { modeOf, modePolicies, WORK_MODE } from '../src/policy/modes';

const WORKSPACE = '/home/dev/app';

function gateFor(mode: (typeof WORK_MODE)[keyof typeof WORK_MODE]): LocalGate {
  return new LocalGate(modePolicies(mode), { agentName: 'claude-code' });
}

function effect(
  gate: LocalGate,
  request: { action: string; toolClass?: string; target?: string; environment?: string },
): string {
  return gate.evaluate({ workingDirectory: WORKSPACE, ...request }).effect;
}

describe('investigation mode', () => {
  const gate = gateFor(WORK_MODE.INVESTIGATE);

  it.each([
    [{ action: 'mcp.railway.get_logs', toolClass: 'read' }],
    [{ action: 'gh.pr-view', toolClass: 'read' }],
    [{ action: 'psql.select', toolClass: 'read' }],
    [{ action: 'filesystem.read', target: '/etc/hosts', toolClass: 'read' }],
    [{ action: 'filesystem.write', target: `${WORKSPACE}/notes.md`, toolClass: 'write' }],
  ])('lets a read or a note in the workspace through: %j', (request) => {
    expect(effect(gate, request)).toBe('allow');
  });

  it.each([
    [{ action: 'mcp.stripe.create_refund', toolClass: 'write' }],
    [{ action: 'railway.redeploy', toolClass: 'write' }],
    [{ action: 'psql.update', toolClass: 'write' }],
    [{ action: 'gh.pr-merge', toolClass: 'write' }],
    [{ action: 'git.push', toolClass: 'write' }],
    [{ action: 'filesystem.write', target: '/home/dev/.zshrc', toolClass: 'write' }],
  ])('refuses a change outside this machine: %j', (request) => {
    expect(effect(gate, request)).toBe('deny');
  });

  it('knows itself by its rules', () => {
    expect(modeOf(modePolicies(WORK_MODE.INVESTIGATE))).toBe(WORK_MODE.INVESTIGATE);
    expect(modeOf([])).toBeNull();
  });
});

describe('autonomous mode', () => {
  const gate = gateFor(WORK_MODE.AUTONOMOUS);

  it.each([
    [{ action: 'gh.pr-create', toolClass: 'write' }],
    [{ action: 'git.push', toolClass: 'write' }],
    [{ action: 'filesystem.write', target: `${WORKSPACE}/src/x.ts`, toolClass: 'write' }],
    [{ action: 'railway.restart', toolClass: 'write', environment: 'staging' }],
  ])('lets the work through: %j', (request) => {
    expect(effect(gate, request)).toBe('allow');
  });

  it.each([
    [{ action: 'mcp.stripe.create_refund', toolClass: 'write' }],
    [{ action: 'railway.up', toolClass: 'write' }],
    [{ action: 'gh.secret-set', toolClass: 'write' }],
    [{ action: 'mcp.railway.delete_service', toolClass: 'destructive' }],
    [{ action: 'railway.restart', toolClass: 'write', environment: 'production' }],
  ])('stops at money, deploys, authority, deletes and production: %j', (request) => {
    expect(effect(gate, request)).toBe('deny');
  });
});

describe('a task declared as an investigation', () => {
  const task = {
    id: 'tsk_1',
    sessionId: 'ses_1',
    statement: 'investigate why the payments failed',
    scope: {},
    declaredAt: '2026-09-26T10:00:00.000Z',
    intent: 'investigate' as const,
  };

  it('refuses a change outside this machine with the ask quoted, and lets reads through', () => {
    const gate = new LocalGate([], { agentName: 'claude-code', task });
    const refund = gate.evaluate({
      action: 'mcp.stripe.create_refund',
      toolClass: 'write',
    });
    expect(refund.effect).toBe('deny');
    expect(refund.reason).toContain('investigate why the payments failed');
    expect(
      gate.evaluate({ action: 'mcp.stripe.list_charges', toolClass: 'read' }).effect,
    ).toBe('allow');
    expect(
      gate.evaluate({ action: 'filesystem.write', target: '/w/a.ts', toolClass: 'write' })
        .effect,
    ).toBe('allow');
  });
});
