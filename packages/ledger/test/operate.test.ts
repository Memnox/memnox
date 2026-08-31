import { describe, expect, it } from 'vitest';
import { RISK_LEVEL } from '@memnox/core';
import { computeCoverage } from '../src/coverage';
import {
  CHAIN_PATTERN,
  computeDrift,
  detectChain,
  type DriftBaseline,
} from '../src/drift';

const FULL = {
  workspaceId: 'ws_1',
  from: '2026-08-24',
  to: '2026-08-31',
  byRisk: {
    [RISK_LEVEL.LOW]: { seen: 100, governed: 100 },
    [RISK_LEVEL.MEDIUM]: { seen: 10, governed: 10 },
    [RISK_LEVEL.HIGH]: { seen: 5, governed: 5 },
    [RISK_LEVEL.CRITICAL]: { seen: 2, governed: 2 },
  },
  seamsCovered: 4,
  seamsTotal: 4,
  installsEnforcing: 40,
  installsTotal: 40,
  topUngoverned: [],
};

describe('coverage', () => {
  it('is one only when actions, seams and installs are all covered', () => {
    expect(computeCoverage(FULL).coverage).toBe(1);
  });

  it('will not read high while every irreversible action is ungoverned', () => {
    const readLoop = computeCoverage({
      ...FULL,
      byRisk: { ...FULL.byRisk, [RISK_LEVEL.CRITICAL]: { seen: 2, governed: 0 } },
    });

    // 115 of 117 actions governed is 98% unweighted. Weighting by risk is what stops
    // a read loop from reporting near-total coverage over ungoverned deletes.
    const unweighted = readLoop.actionsGoverned / readLoop.actionsSeen;
    expect(unweighted).toBeGreaterThan(0.97);
    expect(readLoop.coverage).toBeLessThan(unweighted - 0.15);
  });

  it('counts an agent governed on one seam of four as a quarter, not as governed', () => {
    const partial = computeCoverage({ ...FULL, seamsCovered: 1 });

    expect(partial.coverage).toBeCloseTo(0.25);
  });

  it('treats one unarmed machine in forty as a hole, not a rounding error', () => {
    const drifted = computeCoverage({ ...FULL, installsEnforcing: 39 });

    expect(drifted.coverage).toBeLessThan(1);
  });
});

describe('drift', () => {
  const baseline: DriftBaseline = {
    subjectId: 'agt_1',
    windowDays: 7,
    surfaces: ['filesystem'],
    destinations: ['api.github.com'],
    tools: ['github.get_issue'],
    models: ['claude-opus-5'],
    computedAt: '2026-08-24T00:00:00.000Z',
  };

  const observed = {
    subjectId: 'agt_1',
    surfaces: ['filesystem', 'cloud'],
    destinations: ['api.github.com'],
    tools: ['github.get_issue', 'postgres.drop_table'],
    models: ['claude-opus-5'],
  };

  it('says nothing when an agent did what it did last week', () => {
    expect(
      computeDrift(baseline, {
        ...observed,
        surfaces: baseline.surfaces,
        tools: baseline.tools,
      }),
    ).toBeNull();
  });

  it('reads as a change to approve when the cause is known', () => {
    const finding = computeDrift(baseline, observed, 'mcp_server_added: postgres');

    expect(finding?.cause).toContain('postgres');
    expect(finding?.severity).toBe('low');
  });

  it('stands out against the explained ones when nothing explains it', () => {
    const unexplained = computeDrift(baseline, observed);
    const explained = computeDrift(baseline, observed, 'mcp_server_added: postgres');

    expect(unexplained?.severity).not.toBe(explained?.severity);
    expect(unexplained?.authorityDelta).toBe(2);
  });

  it('is high when an unexplained widening is broad', () => {
    const broad = computeDrift(baseline, {
      ...observed,
      destinations: ['api.github.com', 'evil.example', 'another.example'],
    });

    expect(broad?.severity).toBe('high');
  });
});

describe('the chain view', () => {
  const at = '2026-08-31T09:00:00.000Z';

  it('sees an escalation no single verdict could have', () => {
    const finding = detectChain('cor_1', [
      { subjectId: 'agt_1', action: 'filesystem.read', at, resourceKind: 'secret' },
      { subjectId: 'agt_2', action: 'repository.write', at },
      { subjectId: 'agt_3', action: 'cloud.deploy', at },
    ]);

    expect(finding?.pattern).toBe(CHAIN_PATTERN.PRIVILEGE_ESCALATION);
    expect(finding?.severity).toBe('high');
  });

  it('proposes containment rather than taking it', () => {
    const finding = detectChain('cor_1', [
      { subjectId: 'agt_1', action: 'filesystem.read', at, resourceKind: 'secret' },
      { subjectId: 'agt_2', action: 'repository.write', at },
    ]);

    expect(finding?.containmentProposed).toBe(true);
  });

  it('says nothing about one agent doing its own ordinary work', () => {
    expect(
      detectChain('cor_1', [
        { subjectId: 'agt_1', action: 'filesystem.read', at, resourceKind: 'secret' },
        { subjectId: 'agt_1', action: 'cloud.deploy', at },
      ]),
    ).toBeNull();
  });
});
