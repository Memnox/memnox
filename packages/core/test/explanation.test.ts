import { describe, expect, it } from 'vitest';
import {
  buildExplanation,
  DECISION_EFFECT,
  ENFORCEMENT_MODE,
  EXPLANATION_EVIDENCE,
  EXPLANATION_MAX_LINES,
  RISK_LEVEL,
  SCOPE_MATCH,
  type ActionRequest,
  type Decision,
} from '../src/index';

const RULE = { id: 'pol_1', name: 'secrets-not-required', version: '3' };

function decision(over: Partial<Decision> = {}): Decision {
  return {
    eventId: 'dec_01JQ2',
    effect: DECISION_EFFECT.DENY,
    riskLevel: RISK_LEVEL.HIGH,
    reason: 'this task declared no credential need',
    matchedPolicies: [],
    mode: ENFORCEMENT_MODE.ENFORCE,
    evaluatedAt: '2026-08-31T09:00:00.000Z',
    latencyUs: 180,
    rule: RULE,
    ...over,
  };
}

const request: ActionRequest = { action: 'filesystem.read', target: '.env' };

describe('buildExplanation', () => {
  it('opens with what was asked and closes with what happened', () => {
    const explanation = buildExplanation({
      decision: decision(),
      request,
      agentName: 'Claude Code',
    });

    expect(explanation.decisionId).toBe('dec_01JQ2');
    expect(explanation.lines[0]?.claim).toBe('Claude Code asked to filesystem.read .env');
    expect(explanation.lines.at(-1)?.claim).toContain('DENY');
  });

  it('names the permitted alternative in the outcome, because a refusal that names one gets taken', () => {
    const explanation = buildExplanation({
      decision: decision({
        alternative: {
          action: 'filesystem.read',
          resource: '.env.example',
          note: 'readable',
        },
      }),
      request,
    });

    expect(explanation.lines.at(-1)?.claim).toContain(
      'filesystem.read .env.example is permitted instead',
    );
  });

  it('names the action alone when the rule named no resource', () => {
    const explanation = buildExplanation({
      decision: decision({
        alternative: { action: 'filesystem.read', note: 'read something else' },
      }),
      request,
    });

    expect(explanation.lines.at(-1)?.claim).toContain(
      'filesystem.read is permitted instead',
    );
  });

  it('cites the rule version, so the line is traceable a year later', () => {
    const explanation = buildExplanation({ decision: decision(), request });
    const cited = explanation.lines.find(
      (line) => line.evidence.kind === EXPLANATION_EVIDENCE.RULE,
    );

    expect(cited?.evidence).toEqual({ kind: EXPLANATION_EVIDENCE.RULE, rule: RULE });
  });

  it('explains an allow as the conditions that were met', () => {
    const explanation = buildExplanation({
      decision: decision({
        effect: DECISION_EFFECT.ALLOW,
        reason: 'release-engineer may merge here',
        approvalId: 'apr_7731',
      }),
      request: { action: 'github.merge_pull_request', target: '#821' },
      agentName: 'claude-code',
      scope: { match: SCOPE_MATCH.IN_SCOPE },
    });

    const claims = explanation.lines.map((line) => line.claim);
    // "Why did we trust it" is the question an auditor asks first, and almost nothing
    // in this category answers it.
    expect(claims).toContain('the request was inside what the task declared');
    expect(claims).toContain('a person approved it (apr_7731)');
    expect(claims[claims.length - 1]).toContain('ALLOW');
  });

  it('keeps the outcome line whatever else fills the five', () => {
    const explanation = buildExplanation({
      decision: decision({ effect: DECISION_EFFECT.ALLOW, approvalId: 'apr_1' }),
      request: {
        action: 'github.merge_pull_request',
      },
      agentName: 'claude-code',
      scope: { match: SCOPE_MATCH.IN_SCOPE },
    });

    expect(explanation.lines).toHaveLength(5);
    expect(explanation.lines[4]?.claim).toContain('ALLOW');
  });

  it('names the dimension a request fell outside, and never more than five lines', () => {
    const explanation = buildExplanation({
      decision: decision(),
      request,
      agentName: 'Claude Code',
      scope: {
        match: SCOPE_MATCH.OUT_OF_SCOPE,
        dimension: 'path',
        declared: ['src/auth/**'],
        actual: '.env',
      },
    });

    expect(explanation.lines.length).toBeLessThanOrEqual(EXPLANATION_MAX_LINES);
    expect(explanation.lines.some((line) => line.claim.includes('src/auth/**'))).toBe(
      true,
    );
  });
});
