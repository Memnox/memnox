import { describe, expect, it } from 'vitest';
import {
  buildActionBriefing,
  CONSTRAINT_SOURCE,
  renderActionBriefing,
} from '../src/domain/action-briefing';
import { DECISION_EFFECT } from '../src/constants/decision.constants';
import { RISK_LEVEL } from '../src/constants/risk.constants';
import type { RiskAssessment } from '../src/domain/risk-assessment';

const assessment = (over: Partial<RiskAssessment> = {}): RiskAssessment => ({
  effect: DECISION_EFFECT.ESCALATE,
  riskLevel: RISK_LEVEL.MEDIUM,
  reason: 'payment code',
  matchedPolicies: [
    {
      name: 'payment-code-approval',
      effect: DECISION_EFFECT.ESCALATE,
      reason: 'Payment logic changes need security review.',
      approvers: ['security-team'],
    },
  ],
  advisories: [],
  ...over,
});

describe('buildActionBriefing', () => {
  it('quotes the policy rather than inventing guidance', () => {
    const briefing = buildActionBriefing(
      { action: 'code.modify', target: 'payment/checkout.ts' },
      assessment(),
    );

    expect(briefing.wouldBe).toBe(DECISION_EFFECT.ESCALATE);
    expect(briefing.constraints).toEqual([
      {
        source: CONSTRAINT_SOURCE.POLICY,
        name: 'payment-code-approval',
        effect: DECISION_EFFECT.ESCALATE,
        statement: 'Payment logic changes need security review.',
        approvers: ['security-team'],
      },
    ]);
  });

  it('carries advisories through as constraints in their own words', () => {
    const briefing = buildActionBriefing(
      { action: 'database.drop', target: 'users' },
      assessment({
        matchedPolicies: [],
        advisories: [
          {
            source: 'decision-memory',
            escalateTo: DECISION_EFFECT.WITHHOLD,
            reason: 'conflicts with team decision "PCI data stays out" (finance)',
            signals: ['decision:d-1'],
          },
        ],
      }),
    );

    expect(briefing.constraints[0]?.source).toBe(CONSTRAINT_SOURCE.ADVISOR);
    expect(briefing.constraints[0]?.statement).toContain('PCI data stays out');
  });

  it('marks a constraint no approval can satisfy', () => {
    const briefing = buildActionBriefing(
      { action: 'database.drop' },
      assessment({
        matchedPolicies: [],
        advisories: [
          {
            source: 'taint-guard',
            escalateTo: DECISION_EFFECT.WITHHOLD,
            nonOverridable: true,
            reason: 'irreversible action from a tainted session',
            signals: [],
          },
        ],
      }),
    );

    expect(briefing.constraints[0]?.nonOverridable).toBe(true);
  });

  it('leaves a signal-only advisory without an effect', () => {
    const briefing = buildActionBriefing(
      { action: 'file.read' },
      assessment({
        matchedPolicies: [],
        advisories: [
          { source: 'behavior-guard', reason: '40 actions in 60s', signals: [] },
        ],
      }),
    );

    expect(briefing.constraints[0]?.effect).toBeUndefined();
  });
});

describe('renderActionBriefing', () => {
  it('renders something an agent can paste into its context', () => {
    const text = renderActionBriefing(
      buildActionBriefing(
        {
          action: 'code.modify',
          target: 'payment/checkout.ts',
          environment: 'production',
        },
        assessment(),
      ),
    );

    expect(text).toContain('code.modify payment/checkout.ts');
    expect(text).toContain('in production');
    expect(text).toContain('need human approval');
    expect(text).toContain('Payment logic changes need security review.');
    expect(text).toContain('approvers: security-team');
    // The boundary is restated in the output itself.
    expect(text).toContain('None of this is a judgement on the work itself');
  });

  it('names the source, so a declared rule is never read as an advisor signal', () => {
    const text = renderActionBriefing(
      buildActionBriefing(
        { action: 'code.modify', target: 'payment/checkout.ts' },
        assessment({
          advisories: [
            { source: 'behavior-guard', reason: '40 actions in 60s', signals: [] },
          ],
        }),
      ),
    );

    expect(text).toContain('payment-code-approval — your policy, requires approval');
    expect(text).toContain('behavior-guard — signal, no effect on its own');
  });

  it('says who to ask, not only that approval is missing', () => {
    const text = renderActionBriefing(
      buildActionBriefing({ action: 'code.modify' }, assessment()),
    );

    expect(text).toContain('Next: ask security-team to approve before this proceeds.');
  });

  it('says a sealed withhold cannot be approved past', () => {
    const text = renderActionBriefing(
      buildActionBriefing(
        { action: 'database.drop' },
        assessment({
          effect: DECISION_EFFECT.WITHHOLD,
          matchedPolicies: [],
          advisories: [
            {
              source: 'taint-guard',
              escalateTo: DECISION_EFFECT.WITHHOLD,
              nonOverridable: true,
              reason: 'irreversible action from a tainted session',
              signals: [],
            },
          ],
        }),
      ),
    );

    expect(text).toContain('Next: no approval can satisfy this');
    expect(text).toContain('taint-guard — signal, withholds (no override)');
  });

  it('wraps at a fixed column rather than the terminal width', () => {
    const text = renderActionBriefing(
      buildActionBriefing(
        { action: 'file.write' },
        assessment({
          matchedPolicies: [
            {
              name: 'per-object-authorization',
              effect: DECISION_EFFECT.ESCALATE,
              reason:
                'Authorize the specific object being touched, not just that the caller is logged in — skipping the per-object check is IDOR.',
            },
          ],
        }),
      ),
    );

    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(78);
  });

  it('says an unconstrained action is ungoverned, not endorsed', () => {
    const text = renderActionBriefing(
      buildActionBriefing(
        { action: 'file.read' },
        assessment({
          effect: DECISION_EFFECT.ALLOW,
          matchedPolicies: [],
          riskLevel: RISK_LEVEL.LOW,
        }),
      ),
    );

    expect(text).toContain('No rule your organization wrote covers this action.');
    expect(text).toContain('be allowed');
  });

  it('is deterministic — the same briefing renders identically', () => {
    const briefing = buildActionBriefing({ action: 'deploy.service' }, assessment());

    expect(renderActionBriefing(briefing)).toBe(renderActionBriefing(briefing));
  });
});
