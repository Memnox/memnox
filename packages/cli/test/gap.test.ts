import { describe, expect, it } from 'vitest';
import type { Policy } from '@memnox/core';
import { gapLines, measureGap, reachingActions } from '../src/commands/scan.command';
import type { DiscoveryReport } from '@memnox/core';

const report = (over: Partial<DiscoveryReport> = {}): DiscoveryReport =>
  ({
    agents: [],
    surfaces: [
      {
        agentId: 'agt_1',
        kind: 'mcp',
        detectedFrom: '.claude.json',
        tools: [
          { server: 'github', name: 'merge_pull_request', effect: 'write' },
          { server: 'github', name: 'get_issue', effect: 'read' },
          { server: 'fs', name: 'delete_file', effect: 'destructive' },
        ],
        servers: [],
      },
    ],
    resources: [],
    reachability: [],
    read: [],
    probed: [],
    tools: [],
    egress: { outbound: 'unknown', proxyVars: [], noProxy: [], sandbox: [], read: [] },
    credentials: [],
    authenticated: [
      {
        name: 'gh',
        via: '~/.config/gh/hosts.yml',
        headline: 'can merge pull requests',
        externalStateVerbs: 5,
        destructiveVerbs: 3,
      },
    ],
    ...over,
  }) as unknown as DiscoveryReport;

const rule = (actions: string[]): Policy =>
  ({
    name: 'r',
    match: { actions },
    decision: { effect: 'deny', reason: 'no' },
  }) as unknown as Policy;

describe('the gap', () => {
  it('counts what reaches outside, and never counts a read', () => {
    const actions = reachingActions(report());
    expect(actions).toContain('mcp.merge_pull_request');
    expect(actions).toContain('mcp.delete_file');
    expect(actions).not.toContain('mcp.get_issue');
  });

  it('counts CLI verbs from the same tables enforcement reads', () => {
    const actions = reachingActions(report());
    expect(actions.some((each) => each.startsWith('gh.'))).toBe(true);
  });

  it('says none are governed when no rule matches — never a count of rule files', () => {
    const gap = measureGap(report(), [rule(['deploy.service'])]);
    expect(gap.governed).toBe(0);
    expect(gapLines(gap)[1]).toBe('None of them is governed by a policy.');
  });

  it('counts a capability as governed only when a rule actually matches it', () => {
    const gap = measureGap(report(), [rule(['mcp.merge_pull_request'])]);
    expect(gap.governed).toBe(1);
    expect(gapLines(gap)[1]).toContain('1 of them is governed');
  });

  it('counts a wildcard rule across everything it covers', () => {
    const gap = measureGap(report(), [rule(['mcp.*'])]);
    expect(gap.governed).toBe(2);
  });

  it('never reports more governed than exist', () => {
    const gap = measureGap(report(), [rule(['*'])]);
    expect(gap.governed).toBeLessThanOrEqual(gap.total);
  });

  it('reads as an answer on a machine with nothing on it', () => {
    const empty = measureGap(report({ surfaces: [], authenticated: [] } as never), []);
    expect(empty.total).toBe(0);
    expect(gapLines(empty)[0]).toContain('0 capabilities');
  });
});
