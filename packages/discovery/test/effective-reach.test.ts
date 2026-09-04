import { describe, expect, it } from 'vitest';
import { effectiveReach } from '../src/effective-reach';
import { RESOURCE_KIND, SENSITIVITY, SURFACE_KIND } from '../src/discovery.constants';
import type { DiscoveryReport } from '../src/discover';

const AGENT = { id: 'claude-code', kind: 'claude-code' };

function build(surfaces: unknown[], resources: unknown[]): DiscoveryReport {
  return { agents: [AGENT], surfaces, resources } as unknown as DiscoveryReport;
}

function resource(id: string, kind: string, declaredIn: string) {
  return {
    id,
    kind,
    declaredIn,
    sensitivity: SENSITIVITY.SENSITIVE,
    reachableBy: [AGENT],
  };
}

const MCP_SURFACE = {
  agentId: 'claude-code',
  kind: SURFACE_KIND.MCP,
  detectedFrom: '~/.config/mcp.json',
};

describe('effectiveReach', () => {
  it('follows a credential to a database the agent was never named on', () => {
    const found = effectiveReach(
      build(
        [MCP_SURFACE],
        [
          resource('AWS_SECRET_ACCESS_KEY', RESOURCE_KIND.SECRET, '~/.aws/credentials'),
          resource('postgres://prod-db/payments', RESOURCE_KIND.DB, '.env'),
        ],
      ),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.because).toBe('credential');
    expect(found[0]?.path.map((hop) => hop.kind)).toEqual([
      'agent',
      'surface',
      'credential',
      'resource',
    ]);
  });

  it('names a shell as the reason when no credential explains it', () => {
    const found = effectiveReach(
      build(
        [{ agentId: 'claude-code', kind: SURFACE_KIND.SHELL, detectedFrom: '~/.zshrc' }],
        [resource('postgres://prod-db/payments', RESOURCE_KIND.DB, '.env')],
      ),
    );
    expect(found[0]?.because).toBe('shell');
  });

  it('says nothing about a resource the agent surface names directly', () => {
    const found = effectiveReach(
      build(
        [MCP_SURFACE],
        [resource('postgres://prod-db/payments', RESOURCE_KIND.DB, '~/.config/mcp.json')],
      ),
    );
    expect(found).toEqual([]);
  });

  it('carries evidence on every hop, so no step is an assertion', () => {
    const found = effectiveReach(
      build(
        [MCP_SURFACE],
        [
          resource('AWS_SECRET_ACCESS_KEY', RESOURCE_KIND.SECRET, '~/.aws/credentials'),
          resource('postgres://prod-db/payments', RESOURCE_KIND.DB, '.env'),
        ],
      ),
    );
    expect(found[0]?.path.every((hop) => hop.evidence !== '')).toBe(true);
  });

  it('is empty when the agent holds no surface at all', () => {
    const report = { agents: [AGENT], surfaces: [], resources: [] };
    expect(effectiveReach(report as unknown as DiscoveryReport)).toEqual([]);
  });
});
