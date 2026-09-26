import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileAllowances, type Allowance } from '../src/gate/allowances';
import { LocalGate } from '../src/gate/local-gate';

const NOW = new Date('2026-09-26T10:00:00.000Z');

const STAGING: Allowance = {
  id: 'alw_1',
  actions: ['railway.*'],
  environments: ['staging'],
  agents: ['claude-code'],
  by: 'moise',
  reason: 'reproducing the retry bug',
  since: '2026-09-26T09:50:00.000Z',
  until: '2026-09-26T10:20:00.000Z',
};

const RULES = [
  {
    name: 'cli-ask',
    match: { actions: ['railway.*'], classes: ['write'] },
    decision: { effect: 'ask', reason: 'a person looks at CLI changes' },
  },
  {
    name: 'no-deploys',
    match: { actions: ['railway.up'] },
    decision: { effect: 'deny', reason: 'deploys go through CI' },
  },
];

function gate(allowances: readonly Allowance[], now = NOW): LocalGate {
  return new LocalGate(RULES as never, { agentName: 'claude-code', allowances, now });
}

describe('a scope a person allowed for a while', () => {
  it('turns an ask inside it into an allow, and says who allowed it until when', () => {
    const verdict = gate([STAGING]).evaluate({
      action: 'railway.restart',
      toolClass: 'write',
      environment: 'staging',
    });
    expect(verdict.effect).toBe('allow');
    expect(verdict.reason).toContain('moise allowed this until 2026-09-26T10:20:00.000Z');
  });

  it('leaves an ask outside it, in another environment or for another agent', () => {
    expect(
      gate([STAGING]).evaluate({
        action: 'railway.restart',
        toolClass: 'write',
        environment: 'production',
      }).effect,
    ).toBe('ask');
  });

  it('never overrules a refusal', () => {
    expect(
      gate([STAGING]).evaluate({
        action: 'railway.up',
        toolClass: 'write',
        environment: 'staging',
      }).effect,
    ).toBe('deny');
  });

  it('ends on its own', () => {
    const later = new Date('2026-09-26T10:30:00.000Z');
    expect(
      gate([STAGING], later).evaluate({
        action: 'railway.restart',
        toolClass: 'write',
        environment: 'staging',
      }).effect,
    ).toBe('ask');
  });

  it('is kept on disk, read by a gate that decides later, and revoked on the record', async () => {
    const store = new FileAllowances(await mkdtemp(join(tmpdir(), 'memnox-allow-')));
    await store.add(STAGING);
    expect(store.inForceNow(NOW.toISOString()).map((each) => each.id)).toEqual(['alw_1']);
    await store.revoke('alw_1', NOW.toISOString());
    expect(await store.inForce(NOW.toISOString())).toEqual([]);
  });
});
