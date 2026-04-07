import { describe, expect, it } from 'vitest';
import {
  CLEAN_TAINT,
  classifySourceTaint,
  isRecordTainted,
  mergeTaint,
  parseTaintAssessment,
  TAINT_MAX_SOURCE_REFS,
  TAINT_META_AUTHOR_ASSOCIATION,
  TAINT_META_AUTHOR_IS_MEMBER,
  TAINT_META_SOURCE_TYPE,
  type TaintAssessment,
} from '../src/index';

describe('classifySourceTaint — source type', () => {
  it('never taints ground-truth sources, whatever their authority', () => {
    for (const sourceType of [
      'github_file',
      'github_symbol',
      'github_line_chunk',
      'extracted_decision',
    ]) {
      expect(classifySourceTaint(sourceType).tainted).toBe(false);
    }
  });

  it('taints third-party free text regardless of author', () => {
    expect(classifySourceTaint('email_message').tainted).toBe(true);
    expect(classifySourceTaint('discord_message').tainted).toBe(true);
    // LLM enrichment cannot launder taint.
    expect(classifySourceTaint('email_message_enriched').tainted).toBe(true);
  });

  it('taints unknown sources by authority threshold', () => {
    expect(classifySourceTaint('some_random_feed').tainted).toBe(true);
    expect(classifySourceTaint('github_commit').tainted).toBe(false);
  });
});

describe('classifySourceTaint — actor', () => {
  it('trusts GitHub content from the repository team', () => {
    for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
      expect(
        classifySourceTaint('github_issue', { authorAssociation: association }).tainted,
      ).toBe(false);
    }
  });

  it('taints the same GitHub source type when the author is an outsider', () => {
    const outsider = classifySourceTaint('github_issue', { authorAssociation: 'NONE' });
    expect(outsider.tainted).toBe(true);
    expect(outsider.reason).toContain('NONE');
    expect(
      classifySourceTaint('github_comment', {
        authorAssociation: 'FIRST_TIME_CONTRIBUTOR',
      }).tainted,
    ).toBe(true);
  });

  it('falls back to authority when no association was captured', () => {
    // Pre-taint history sync: a team-tracker source type keeps its authority verdict.
    expect(classifySourceTaint('github_pull_request').tainted).toBe(false);
    expect(classifySourceTaint('github_comment').tainted).toBe(true);
  });

  it('trusts Slack only from workspace members', () => {
    expect(
      classifySourceTaint('slack_message', { authorIsWorkspaceMember: true }).tainted,
    ).toBe(false);
    expect(
      classifySourceTaint('slack_message', { authorIsWorkspaceMember: false }).tainted,
    ).toBe(true);
    expect(classifySourceTaint('slack_message').tainted).toBe(true);
  });
});

describe('isRecordTainted', () => {
  it('honours a persisted flag in either position', () => {
    expect(isRecordTainted({ sourceType: 'email_message', tainted: false })).toBe(false);
    expect(isRecordTainted({ sourceType: 'github_file', tainted: true })).toBe(true);
    expect(
      isRecordTainted({ sourceType: 'github_file', metadata: { tainted: true } }),
    ).toBe(true);
  });

  it('re-derives taint for records that carry no flag', () => {
    expect(isRecordTainted({ sourceType: 'email_message' })).toBe(true);
    expect(isRecordTainted({ sourceType: 'github_file' })).toBe(false);
    expect(
      isRecordTainted({
        metadata: {
          [TAINT_META_SOURCE_TYPE]: 'github_issue',
          [TAINT_META_AUTHOR_ASSOCIATION]: 'NONE',
        },
      }),
    ).toBe(true);
    expect(
      isRecordTainted({
        sourceType: 'slack_message',
        metadata: { [TAINT_META_AUTHOR_IS_MEMBER]: true },
      }),
    ).toBe(false);
  });

  it('treats a record with no provenance at all as untrusted', () => {
    expect(isRecordTainted({})).toBe(true);
  });
});

describe('mergeTaint', () => {
  it('merges monotonically and dedups sources', () => {
    const email: TaintAssessment = {
      tainted: true,
      sources: [{ sourceType: 'email_message', reason: 'third-party email' }],
    };
    const merged = mergeTaint(email, mergeTaint(email, CLEAN_TAINT));
    expect(merged.tainted).toBe(true);
    expect(merged.sources).toHaveLength(1);
  });

  it('caps the carried source refs', () => {
    const many: TaintAssessment = {
      tainted: true,
      sources: Array.from({ length: TAINT_MAX_SOURCE_REFS * 2 }, (_unused, index) => ({
        sourceType: 'email_message',
        reference: `msg-${index}`,
        reason: 'third-party email',
      })),
    };
    expect(mergeTaint(CLEAN_TAINT, many).sources).toHaveLength(TAINT_MAX_SOURCE_REFS);
  });
});

describe('parseTaintAssessment', () => {
  it('round-trips a well-formed assessment', () => {
    const assessment: TaintAssessment = {
      tainted: true,
      sources: [
        { sourceType: 'email_message', reference: 'msg-1', reason: 'third-party email' },
      ],
    };
    expect(parseTaintAssessment(JSON.stringify(assessment))).toEqual(assessment);
  });

  it('rejects anything malformed rather than half-parsing it', () => {
    expect(parseTaintAssessment('not json')).toBeNull();
    expect(parseTaintAssessment('null')).toBeNull();
    expect(parseTaintAssessment('{"tainted":true}')).toBeNull();
    expect(parseTaintAssessment('{"tainted":"yes","sources":[]}')).toBeNull();
    expect(
      parseTaintAssessment('{"tainted":true,"sources":[{"reason":"x"}]}'),
    ).toBeNull();
  });
});
