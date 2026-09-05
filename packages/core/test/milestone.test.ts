import { describe, expect, it } from 'vitest';
import {
  decodeMessage,
  describeMilestone,
  encodeMessage,
  idFromRef,
  MILESTONE_REASON,
  milestonesToForget,
  refFor,
  type Milestone,
} from '../src/recovery/milestone';

const milestone = (id: string, takenAt: string): Milestone => ({
  id,
  commit: 'abc123',
  takenAt,
  reason: MILESTONE_REASON.SESSION,
  files: 3,
});

describe('what a milestone records', () => {
  /* A ref holds one sha and nothing else, so the record rides in the commit message.
     A sidecar file would go missing exactly when somebody needed it. */
  it('round-trips through the commit message', () => {
    const written = {
      takenAt: '2026-09-05T10:00:00.000Z',
      reason: MILESTONE_REASON.SESSION,
      files: 12,
      sessionId: 'ses_abc',
      note: 'before the agent',
    };

    expect(decodeMessage(encodeMessage(written))).toEqual(written);
  });

  it('reads a message whose reason it does not recognise', () => {
    const decoded = decodeMessage(
      'memnox-milestone 2026-09-05T10:00:00.000Z\n\nreason: martian\nfiles: 2\n',
    );

    expect(decoded?.reason).toBe(MILESTONE_REASON.MANUAL);
  });

  it('refuses a commit that is not one of ours', () => {
    expect(decodeMessage('fix: something unrelated\n')).toBeNull();
  });

  it('names its own ref, and reads the name back', () => {
    expect(idFromRef(refFor('mst_x1'))).toBe('mst_x1');
    expect(idFromRef('refs/heads/main')).toBeNull();
  });
});

describe('forgetting the old ones', () => {
  const many = [
    milestone('a', '2026-09-05T10:00:00.000Z'),
    milestone('b', '2026-09-05T09:00:00.000Z'),
    milestone('c', '2026-09-05T08:00:00.000Z'),
  ];

  it('drops the oldest first', () => {
    expect(milestonesToForget(many, 2).map((one) => one.id)).toEqual(['c']);
  });

  /* Keeping nothing would delete the one thing somebody is about to reach for, and a
     rewind with no milestone is a rewind that lost the work it was meant to save. */
  it('never drops the newest, whatever it is asked to keep', () => {
    expect(milestonesToForget(many, 0).map((one) => one.id)).toEqual(['b', 'c']);
  });
});

describe('how a milestone reads in a listing', () => {
  it('says how long ago, in the unit a person would use', () => {
    const at = '2026-09-05T10:00:00.000Z';
    expect(
      describeMilestone(milestone('mst_x', at), '2026-09-05T10:00:30.000Z'),
    ).toContain('30s ago');
    expect(
      describeMilestone(milestone('mst_x', at), '2026-09-05T10:20:00.000Z'),
    ).toContain('20m ago');
    expect(
      describeMilestone(milestone('mst_x', at), '2026-09-05T13:00:00.000Z'),
    ).toContain('3h ago');
  });
});
