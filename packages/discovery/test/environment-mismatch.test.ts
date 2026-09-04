import { describe, expect, it } from 'vitest';
import { environmentMismatches } from '../src/environment-mismatch';
import { RESOURCE_KIND, SENSITIVITY } from '../src/discovery.constants';
import type { DiscoveryReport } from '../src/discover';

const AGENT = { id: 'claude-code', kind: 'claude-code' };

function report(resources: DiscoveryReport['resources']): DiscoveryReport {
  return {
    agents: [AGENT],
    surfaces: [],
    resources,
    reachability: [],
    findings: [],
    scannedAt: '2026-03-01T10:00:00.000Z',
  } as unknown as DiscoveryReport;
}

function database(id: string, declaredIn: string): DiscoveryReport['resources'][number] {
  return {
    id,
    kind: RESOURCE_KIND.DB,
    declaredIn,
    sensitivity: SENSITIVITY.SENSITIVE,
    reachableBy: [AGENT],
  } as unknown as DiscoveryReport['resources'][number];
}

describe('environmentMismatches', () => {
  it('reports an agent reaching production from a local checkout', () => {
    const found = environmentMismatches(
      report([database('postgres://prod-db/payments', '.env')]),
      ['/Users/moise/code/payments'],
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.agentKind).toBe('claude-code');
    expect(found[0]?.reaches[0]?.declaredIn).toBe('.env');
  });

  it('says nothing when the reach is not production', () => {
    const found = environmentMismatches(
      report([database('postgres://localhost/payments', '.env')]),
      ['/Users/moise/code/payments'],
    );
    expect(found).toEqual([]);
  });

  it('says nothing when the work itself is production, which is not a mismatch', () => {
    const found = environmentMismatches(
      report([database('postgres://prod-db/payments', '.env')]),
      ['/srv/production/payments'],
    );
    expect(found).toEqual([]);
  });

  it('leaves an agent that cannot reach it out of the report', () => {
    const unreachable = {
      ...database('postgres://prod-db/payments', '.env'),
      reachableBy: [{ id: 'cursor', kind: 'cursor' }],
    } as unknown as DiscoveryReport['resources'][number];
    const found = environmentMismatches(report([unreachable]), ['/Users/moise/code']);
    expect(found).toEqual([]);
  });

  it('is empty on a machine with nothing reachable, so it stays honest when clean', () => {
    expect(environmentMismatches(report([]), ['/Users/moise/code'])).toEqual([]);
  });
});
