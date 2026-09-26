import { describe, expect, it } from 'vitest';
import { replyOf } from '../src/gate/chat-approval';
import type { PendingApproval } from '../src/gate/pending';

function held(id: string): PendingApproval {
  return {
    id,
    request: {
      sessionId: 's1',
      agent: 'claude-code',
      operation: 'gh.pr-merge',
      fingerprint: id,
      reason: 'r',
    },
    askedAt: '2026-09-26T10:00:00.000Z',
    expiresAt: '2026-09-26T10:30:00.000Z',
  };
}

const ONE = [held('apr_a1_b2')];
const TWO = [held('apr_a1_b2'), held('apr_c3_d4')];

describe('reading a reply as an answer', () => {
  it.each([
    ['yes', 'once'],
    ['Allow', 'once'],
    ['go ahead', 'once'],
    ['allow for this session', 'session'],
    ['yes, always', 'session'],
    ['no', 'deny'],
    ["don't", 'deny'],
  ])('reads "%s" as %s when one question waits', (prompt, answer) => {
    expect(replyOf(prompt, ONE)).toEqual({ id: 'apr_a1_b2', answer });
  });

  it('answers nothing with a bare yes while two questions wait', () => {
    expect(replyOf('yes', TWO)).toBeNull();
  });

  it('answers the one a reply names by id', () => {
    expect(replyOf('allow apr_c3_d4', TWO)).toEqual({ id: 'apr_c3_d4', answer: 'once' });
    expect(replyOf('deny apr_zz_zz', TWO)).toBeNull();
  });

  it('reads an instruction as an instruction, however it starts', () => {
    expect(replyOf('now write the tests for the billing module please', ONE)).toBeNull();
    expect(replyOf('no '.repeat(40), ONE)).toBeNull();
    expect(replyOf('yes', [])).toBeNull();
  });
});
