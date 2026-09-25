import { describe, expect, it } from 'vitest';
import { LocalGate } from '@memnox/core';
import { ruleOnCommand } from '../src/interceptor';

const TASK = {
  id: 'tsk_1',
  sessionId: 'ses_1',
  statement: 'fix the retry in payments',
  scope: { paths: ['/work/app/src/payments/**'] },
  declaredAt: '2026-09-25T10:00:00.000Z',
};

function gate(): LocalGate {
  return new LocalGate([], { agentName: 'agent', task: TASK } as never);
}

describe('an action outside the declared task', () => {
  it('is reported as such, which is what the breaker counts', async () => {
    const outcome = await ruleOnCommand('rm', ['/work/app/src/infra/main.tf'], {
      gate: gate(),
    } as never);
    expect(outcome.allowed).toBe(true);
    expect(outcome.outOfScope).toBe(true);
  });

  it('is not, inside it', async () => {
    const outcome = await ruleOnCommand('rm', ['/work/app/src/payments/retry.ts'], {
      gate: gate(),
    } as never);
    expect(outcome.outOfScope).toBeUndefined();
  });
});
