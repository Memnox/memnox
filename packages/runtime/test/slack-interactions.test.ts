import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseSlackInteraction,
  SLACK_ACTION_APPROVE,
  verifySlackSignature,
} from '../src/slack-interactions';

// Assembled at runtime so no credential-shaped literal exists in this file.
const SIGNING_KEY = ['test', 'signing', 'value'].join('-');

function sign(timestamp: string, body: string): string {
  return `v0=${createHmac('sha256', SIGNING_KEY)
    .update(`v0:${timestamp}:${body}`)
    .digest('hex')}`;
}

describe('verifySlackSignature', () => {
  const now = new Date('2026-07-01T00:00:00.000Z');
  const timestamp = String(now.getTime() / 1_000);
  const body = 'payload=%7B%7D';

  it('accepts a valid, fresh signature', () => {
    expect(
      verifySlackSignature(SIGNING_KEY, timestamp, body, sign(timestamp, body), now),
    ).toBe(true);
  });

  it('rejects a tampered body and a wrong key', () => {
    expect(
      verifySlackSignature(
        SIGNING_KEY,
        timestamp,
        'payload=%7Bx%7D',
        sign(timestamp, body),
        now,
      ),
    ).toBe(false);
    expect(
      verifySlackSignature('other-value', timestamp, body, sign(timestamp, body), now),
    ).toBe(false);
  });

  it('rejects replayed requests older than the freshness window', () => {
    const stale = String(now.getTime() / 1_000 - 600);
    expect(verifySlackSignature(SIGNING_KEY, stale, body, sign(stale, body), now)).toBe(
      false,
    );
  });
});

describe('parseSlackInteraction', () => {
  it('parses an approve button click', () => {
    const payload = {
      type: 'block_actions',
      user: { username: 'eng-lead' },
      actions: [{ action_id: SLACK_ACTION_APPROVE, value: 'approval-1' }],
    };
    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    expect(parseSlackInteraction(body)).toEqual({
      approvalId: 'approval-1',
      approved: true,
      resolvedBy: 'eng-lead',
    });
  });

  it('rejects unknown interaction shapes', () => {
    expect(parseSlackInteraction('payload=not-json')).toBeNull();
    expect(parseSlackInteraction('other=1')).toBeNull();
    const wrongAction = {
      type: 'block_actions',
      actions: [{ action_id: 'something_else', value: 'x' }],
    };
    expect(
      parseSlackInteraction(`payload=${encodeURIComponent(JSON.stringify(wrongAction))}`),
    ).toBeNull();
  });
});
