import { describe, expect, it } from 'vitest';
import {
  AGENT_KIND,
  AGENT_STATUS,
  DECISION_EFFECT,
  EMPTY_AGENT_STATS,
  type AgentIdentity,
} from '@memnox/core';
import { CodeGraph, type GraphSource } from '../src/code-graph';
import { BLAST_RADIUS_SIGNAL, BlastRadiusAdvisor } from '../src/blast-radius-advisor';

const AGENT: AgentIdentity = {
  id: 'agent-1',
  name: 'claude-code',
  kind: AGENT_KIND.CLAUDE_CODE,
  status: AGENT_STATUS.ACTIVE,
  tokenHash: 'hash',
  createdAt: '2026-01-01T00:00:00.000Z',
  stats: { ...EMPTY_AGENT_STATS },
};

const SOURCES: GraphSource[] = [
  { path: 'src/utils/money.ts', content: '' },
  { path: 'src/payment/checkout.ts', content: "import '../utils/money';" },
  { path: 'src/blog/post.ts', content: '' },
];

const graph = CodeGraph.build(SOURCES);

const advisorFor = (protectedPaths: string[], wideReachThreshold?: number) =>
  new BlastRadiusAdvisor(graph, {
    protectedPaths,
    approvers: ['security-team'],
    ...(wideReachThreshold === undefined ? {} : { wideReachThreshold }),
  });

describe('BlastRadiusAdvisor', () => {
  it('escalates a helper edit that payment code transitively imports', async () => {
    const advisories = await advisorFor(['*payment/*']).advise(
      { action: 'code.modify', target: 'src/utils/money.ts' },
      { agent: AGENT },
    );
    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.escalateTo).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
    expect(advisories[0]?.signals).toContain(BLAST_RADIUS_SIGNAL.REACHES_PROTECTED_PATH);
    expect(advisories[0]?.approvers).toEqual(['security-team']);
    expect(advisories[0]?.reason).toContain('src/payment/checkout.ts');
  });

  it('stays silent when nothing protected is reachable', async () => {
    const advisories = await advisorFor(['*payment/*']).advise(
      { action: 'code.modify', target: 'src/blog/post.ts' },
      { agent: AGENT },
    );
    expect(advisories).toEqual([]);
  });

  it('ignores actions that do not modify code', async () => {
    const advisories = await advisorFor(['*payment/*']).advise(
      { action: 'code.read', target: 'src/utils/money.ts' },
      { agent: AGENT },
    );
    expect(advisories).toEqual([]);
  });

  it('stays silent when the target is not in the graph', async () => {
    const advisories = await advisorFor(['*payment/*']).advise(
      { action: 'code.modify', target: 'src/does-not-exist.ts' },
      { agent: AGENT },
    );
    expect(advisories).toEqual([]);
  });

  it('stays silent when no graph has been loaded', async () => {
    const advisories = await new BlastRadiusAdvisor(null, {
      protectedPaths: ['*payment/*'],
      approvers: ['security-team'],
    }).advise({ action: 'code.modify', target: 'src/utils/money.ts' }, { agent: AGENT });
    expect(advisories).toEqual([]);
  });

  it('raises a signal-only advisory for a wide-reaching change', async () => {
    const advisories = await advisorFor([], 1).advise(
      { action: 'code.modify', target: 'src/utils/money.ts' },
      { agent: AGENT },
    );
    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.escalateTo).toBeUndefined();
    expect(advisories[0]?.signals).toContain(BLAST_RADIUS_SIGNAL.WIDE_REACH);
  });
});
