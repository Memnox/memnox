import { describe, expect, it } from 'vitest';
import { CONTEXT_TRUST, DECISION_EFFECT } from '@memnox/core';
import { FRAME_KIND, LINEAGE_METHOD } from '../src/ledger.constants';
import { digest, keepFrame, timelineOf, type Frame } from '../src/frame';
import { findUnusedGrants, rollUpUsage, type UsageObservation } from '../src/usage';
import { proposeLeastPrivilege, renderProposal } from '../src/least-privilege';
import { assembleLineage, lineageConfidence } from '../src/lineage';
import { computeCounterfactual } from '../src/counterfactual';

const AGENT = 'agt_claude-code';

const observation = (over: Partial<UsageObservation> = {}): UsageObservation => ({
  agentId: AGENT,
  action: 'filesystem.read',
  resourceKind: 'file',
  resourceId: 'src/index.ts',
  at: '2026-08-28T09:00:00.000Z',
  effect: DECISION_EFFECT.ALLOW,
  ...over,
});

describe('the flight recorder', () => {
  it('hashes a payload rather than keeping it', () => {
    const frame: Frame = {
      id: 'frm_1',
      sessionId: 'ses_1',
      agentId: AGENT,
      at: '2026-08-28T09:00:00.000Z',
      kind: FRAME_KIND.TOOL_CALL,
      summary: 'github.get_issue',
      payloadDigest: digest('{"issue":42,"token":"AKIAEXAMPLE"}'),
      contextTrust: CONTEXT_TRUST.UNTRUSTED,
    };

    expect(JSON.stringify(frame)).not.toContain('AKIAEXAMPLE');
    expect(frame.payloadDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  it('keeps everything that did not simply proceed, and samples what did', () => {
    expect(keepFrame(false, 'dec_withheld')).toBe(true);
    const allowed = Array.from({ length: 200 }, (_, index) =>
      keepFrame(true, `dec_${index}`),
    );
    const kept = allowed.filter(Boolean).length;

    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(allowed.length / 2);
  });

  it('samples the same decision the same way, so a replay is reproducible', () => {
    expect(keepFrame(true, 'dec_42')).toBe(keepFrame(true, 'dec_42'));
  });

  it('reconstructs one session as one timeline from rows', () => {
    const frames: Frame[] = [
      {
        id: 'b',
        sessionId: 's',
        agentId: AGENT,
        at: '2026-08-28T09:01:00.000Z',
        kind: FRAME_KIND.VERDICT,
        summary: 'withhold',
      },
      {
        id: 'a',
        sessionId: 's',
        agentId: AGENT,
        at: '2026-08-28T09:00:00.000Z',
        kind: FRAME_KIND.INTENT,
        summary: 'fix the auth tests',
      },
    ];

    expect(timelineOf(frames).map((frame) => frame.id)).toEqual(['a', 'b']);
  });
});

describe('usage against grant', () => {
  it('counts only what actually proceeded', () => {
    const usage = rollUpUsage([
      observation(),
      observation({ resourceId: 'src/app.ts' }),
      observation({ action: 'database.delete', effect: DECISION_EFFECT.WITHHOLD }),
    ]);

    expect(usage).toHaveLength(1);
    expect(usage[0]?.count).toBe(2);
    expect(usage[0]?.distinctResources).toBe(2);
  });

  it('makes the unused reach the finding', () => {
    const usage = rollUpUsage([observation()]);
    const unused = findUnusedGrants(
      [
        { agentId: AGENT, action: 'filesystem.read', grantedVia: 'surface:filesystem' },
        { agentId: AGENT, action: 'cloud.write', grantedVia: 'surface:cloud' },
        { agentId: AGENT, action: 'database.delete', grantedVia: 'surface:mcp' },
      ],
      usage,
      4,
    );

    expect(unused.map((grant) => grant.action)).toEqual([
      'cloud.write',
      'database.delete',
    ]);
    expect(unused[0]?.observedWindowDays).toBe(4);
  });
});

describe('the least privilege proposal', () => {
  const proposal = proposeLeastPrivilege({
    agentId: AGENT,
    usage: rollUpUsage([observation(), observation({ action: 'shell.execute' })]),
    unused: findUnusedGrants(
      [{ agentId: AGENT, action: 'cloud.write', grantedVia: 'surface:cloud' }],
      rollUpUsage([observation()]),
      4,
    ),
    windowDays: 4,
    sessions: 11,
    coverage: 0.62,
    alwaysAsk: ['shell.execute'],
  });

  it('allows what was used, asks about what must always be asked, denies the rest', () => {
    expect(proposal.allow).toEqual(['filesystem.read']);
    expect(proposal.requireApproval).toEqual(['shell.execute']);
    expect(proposal.deny).toEqual(['cloud.write']);
  });

  it('renders as a policy file in the format a person writes', () => {
    const rendered = renderProposal(proposal);

    expect(rendered).toContain('version: 1');
    expect(rendered).toContain('effect: withhold');
    expect(rendered).toContain('effect: escalate');
  });

  it('states the window and the coverage where they cannot be dropped in the retelling', () => {
    const rendered = renderProposal(proposal);

    expect(rendered).toContain('4 day(s), 11 session(s)');
    expect(rendered).toContain("62% of this agent's traffic");
  });
});

describe('lineage', () => {
  const lineage = assembleLineage('cor_1', [
    {
      at: '2026-08-28T09:00:00.000Z',
      actorId: 'moise',
      actorKind: 'human',
      system: 'terminal',
      correlationId: 'cor_1',
      method: LINEAGE_METHOD.PROPAGATED,
    },
    {
      at: '2026-08-28T09:02:00.000Z',
      actorId: AGENT,
      actorKind: 'agent',
      system: 'github',
      ref: 'PR#842',
      correlationId: 'cor_1',
      method: LINEAGE_METHOD.CLAIMED,
    },
    {
      at: '2026-08-28T09:05:00.000Z',
      actorId: 'deployer',
      actorKind: 'service',
      system: 'ci',
      method: LINEAGE_METHOD.INFERRED,
    },
  ]);

  it('marks every hop with how it was established', () => {
    expect(lineage.hops.map((hop) => hop.method)).toEqual([
      'propagated',
      'claimed',
      'inferred',
    ]);
  });

  it('reports the chain at its weakest hop rather than its strongest', () => {
    expect(lineageConfidence(lineage)).toBeLessThan(0.5);
  });
});

describe('the counterfactual', () => {
  const reachable = [
    { id: 'res_1', kind: 'secret', path: '/home/dev/.aws/credentials' },
    { id: 'res_2', kind: 'file', path: '/home/dev/src/index.ts' },
  ];

  it('reports only what the attempt actually named', () => {
    const counterfactual = computeCounterfactual({
      decisionId: 'dec_1',
      action: 'filesystem.read',
      resource: '/home/dev/.aws/credentials',
      reachable,
    });

    expect(counterfactual.wouldHaveReached).toHaveLength(1);
    expect(counterfactual.basis).toBe('observed_attempt');
  });

  it('reaches nothing when the attempt named nothing, rather than guessing at everything', () => {
    const counterfactual = computeCounterfactual({
      decisionId: 'dec_2',
      action: 'shell.execute',
      reachable,
    });

    expect(counterfactual.wouldHaveReached).toEqual([]);
  });
});
