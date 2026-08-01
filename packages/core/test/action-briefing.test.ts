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
  effect: DECISION_EFFECT.REQUIRE_APPROVAL,
  riskLevel: RISK_LEVEL.MEDIUM,
  reason: 'payment code',
  matchedPolicies: [
    {
      name: 'payment-code-approval',
      effect: DECISION_EFFECT.REQUIRE_APPROVAL,
      reason: 'Payment logic changes need security review.',
      approvers: ['security-team'],
    },
  ],
  advisories: [],
  trustScore: 100,
  ...over,
});

describe('buildActionBriefing', () => {
  it('quotes the policy rather than inventing guidance', () => {
    const briefing = buildActionBriefing(
      { action: 'code.modify', target: 'payment/checkout.ts' },
      assessment(),
    );

    expect(briefing.wouldBe).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
    expect(briefing.constraints).toEqual([
      {
        source: CONSTRAINT_SOURCE.POLICY,
        name: 'payment-code-approval',
        effect: DECISION_EFFECT.REQUIRE_APPROVAL,
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
            escalateTo: DECISION_EFFECT.BLOCK,
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
            escalateTo: DECISION_EFFECT.BLOCK,
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
    expect(text).toContain('None of this is a review of your code');
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

  it('says a sealed block cannot be approved past', () => {
    const text = renderActionBriefing(
      buildActionBriefing(
        { action: 'database.drop' },
        assessment({
          effect: DECISION_EFFECT.BLOCK,
          matchedPolicies: [],
          advisories: [
            {
              source: 'taint-guard',
              escalateTo: DECISION_EFFECT.BLOCK,
              nonOverridable: true,
              reason: 'irreversible action from a tainted session',
              signals: [],
            },
          ],
        }),
      ),
    );

    expect(text).toContain('Next: no approval can satisfy this');
    expect(text).toContain('taint-guard — signal, blocks (no override)');
  });

  it('wraps at a fixed column rather than the terminal width', () => {
    const text = renderActionBriefing(
      buildActionBriefing({ action: 'file.write' }, assessment(), {
        requirements: [
          {
            id: 'authz-check-per-object',
            requirement:
              'Authorize the specific object being touched, not just that the caller is logged in.',
            why: 'Skipping the per-object check is IDOR: a valid session reads another tenant’s data.',
          },
        ],
        version: '2026.08.1',
      }),
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

  it('lists security requirements separately from declared constraints', () => {
    const text = renderActionBriefing(
      buildActionBriefing(
        { action: 'file.write', target: 'src/auth/login.ts' },
        assessment(),
        {
          requirements: [
            {
              id: 'authz-check-per-object',
              requirement: 'Authorize the specific object being touched.',
              why: 'Skipping it is IDOR.',
            },
          ],
          version: '2026.08.1',
        },
      ),
    );

    // Declared rules first — an organization's own words outrank the baseline.
    expect(text.indexOf('Payment logic changes')).toBeLessThan(
      text.indexOf('Authorize the specific object'),
    );
    expect(text).toContain('worth checking for this kind of change');
    expect(text).toContain('why: Skipping it is IDOR.');
    // The id and the baseline version are what make a requirement citable.
    expect(text).toContain('authz-check-per-object');
    expect(text).toContain('(baseline 2026.08.1)');
  });

  it('still shows security requirements when no rule is declared', () => {
    const text = renderActionBriefing(
      buildActionBriefing(
        { action: 'shell.execute', target: 'rm $USER_INPUT' },
        assessment({ matchedPolicies: [], effect: DECISION_EFFECT.ALLOW }),
        {
          requirements: [
            {
              id: 'shell-no-interpolation',
              requirement: 'Pass arguments as a list.',
              why: 'Interpolation is command injection.',
            },
          ],
          version: '2026.08.1',
        },
      ),
    );

    expect(text).toContain('No rule your organization wrote covers this action.');
    expect(text).toContain('Pass arguments as a list.');
  });

  it('stamps the baseline version so a briefing is reproducible', () => {
    const briefing = buildActionBriefing({ action: 'file.write' }, assessment(), {
      requirements: [],
      version: '2026.08.1',
    });

    expect(briefing.securityBaseline).toBe('2026.08.1');
  });
});
