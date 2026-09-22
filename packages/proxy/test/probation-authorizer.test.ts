import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT, type ContainedProbation } from '@memnox/core';
import { UngovernedAuthorizer, type CallAuthorizer } from '../src/call-authorizer';
import { ProbationAuthorizer } from '../src/probation-authorizer';

const ON_PROBATION: ContainedProbation = {
  name: 'slack',
  until: '2026-10-01T00:00:00.000Z',
  trustCommand: 'memnox mcp trust slack',
};

function judged(
  probation: ContainedProbation | null,
  inner: CallAuthorizer = new UngovernedAuthorizer(),
) {
  return new ProbationAuthorizer(inner, 'slack', async () => probation);
}

describe('a wrapped server on probation', () => {
  it('asks before a message goes, whatever the rules allowed', async () => {
    const verdict = await judged(ON_PROBATION).authorize({
      name: 'send_message',
      arguments: {},
    });
    expect(verdict.effect).toBe(DECISION_EFFECT.ASK);
    expect(verdict.reason).toContain('slack is on probation until 2026-10-01');
    expect(verdict.reason).toContain('memnox mcp trust slack');
  });

  it('asks before a destructive call too', async () => {
    const verdict = await judged(ON_PROBATION).authorize({
      name: 'delete_channel',
      arguments: {},
    });
    expect(verdict.effect).toBe(DECISION_EFFECT.ASK);
  });

  it('lets a read through, since reading is how a server earns trust', async () => {
    const verdict = await judged(ON_PROBATION).authorize({
      name: 'list_channels',
      arguments: {},
    });
    expect(verdict.effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('never loosens a rule that already denied', async () => {
    const deny: CallAuthorizer = {
      authorize: async () => ({ effect: DECISION_EFFECT.DENY, reason: 'no messages' }),
    };
    const verdict = await judged(ON_PROBATION, deny).authorize({
      name: 'send_message',
      arguments: {},
    });
    expect(verdict).toEqual({ effect: DECISION_EFFECT.DENY, reason: 'no messages' });
  });

  it('is only the rules once trusted or served', async () => {
    const verdict = await judged(null).authorize({ name: 'send_message', arguments: {} });
    expect(verdict.effect).toBe(DECISION_EFFECT.ALLOW);
  });
});
