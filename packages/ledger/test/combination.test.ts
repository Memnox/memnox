import { describe, expect, it } from 'vitest';
import { combinedSequences, type SequenceObservation } from '../src/combination';

const step = (
  action: string,
  at: string,
  over: Partial<SequenceObservation> = {},
): SequenceObservation => ({
  agentId: 'agt_claude-code',
  sessionId: 'ses_1',
  action,
  at,
  ...over,
});

describe('three harmless actions, in order', () => {
  it('names the shape no single rule refuses', () => {
    const found = combinedSequences([
      step('database.read', '2026-09-01T10:00:00.000Z', { target: 'customers' }),
      step('filesystem.write', '2026-09-01T10:01:00.000Z', { target: '/tmp/export.csv' }),
      step('slack.send_message', '2026-09-01T10:02:00.000Z', { target: '#general' }),
    ]);

    expect(found).toHaveLength(1);
    expect(found[0]?.read.target).toBe('customers');
    expect(found[0]?.write.action).toBe('filesystem.write');
    expect(found[0]?.send.action).toBe('slack.send_message');
  });

  it('does not call it an export when the send came first', () => {
    // A send before the read it would have carried is not an export, and reporting it
    // as one is the false positive that gets the whole finding ignored.
    const found = combinedSequences([
      step('slack.send_message', '2026-09-01T10:00:00.000Z'),
      step('database.read', '2026-09-01T10:01:00.000Z'),
      step('filesystem.write', '2026-09-01T10:02:00.000Z'),
    ]);

    expect(found).toEqual([]);
  });

  it('does not join two sessions into one sequence', () => {
    const found = combinedSequences([
      step('database.read', '2026-09-01T10:00:00.000Z'),
      step('filesystem.write', '2026-09-01T10:01:00.000Z'),
      step('slack.send_message', '2026-09-01T10:02:00.000Z', { sessionId: 'ses_2' }),
    ]);

    expect(found).toEqual([]);
  });

  it('does not join two agents into one sequence', () => {
    const found = combinedSequences([
      step('database.read', '2026-09-01T10:00:00.000Z'),
      step('filesystem.write', '2026-09-01T10:01:00.000Z'),
      step('slack.send_message', '2026-09-01T10:02:00.000Z', { agentId: 'agt_codex' }),
    ]);

    expect(found).toEqual([]);
  });

  it('reports nothing for a session that only read', () => {
    const found = combinedSequences([
      step('database.read', '2026-09-01T10:00:00.000Z'),
      step('repository.read', '2026-09-01T10:01:00.000Z'),
    ]);

    expect(found).toEqual([]);
  });
});
