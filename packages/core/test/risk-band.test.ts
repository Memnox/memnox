import { describe, expect, it } from 'vitest';
import { bandFor, RISK_RULE } from '../src/discovery/risk';
import type { DiscoveryReport } from '../src/discovery/discover';

function report(overrides: Partial<DiscoveryReport> = {}): DiscoveryReport {
  return {
    agents: [],
    surfaces: [],
    resources: [],
    reachability: [],
    read: [],
    probed: [],
    tools: [],
    egress: { outbound: 'restricted', proxyVars: [], noProxy: [], sandbox: [], read: [] },
    credentials: [],
    authenticated: [],
    ...overrides,
  };
}

const surface = (tools: { name: string; effect: string }[], env: string[] = []) => ({
  agentId: 'agt_1',
  kind: 'mcp' as const,
  detectedFrom: '.claude.json',
  tools: tools.map((tool) => ({ ...tool })) as never,
  servers: env.length === 0 ? [] : [{ name: 's', command: 'x', args: [], env }],
});

describe('the risk band', () => {
  it('is low with nothing on the machine, and names no rule', () => {
    const band = bandFor(report());
    expect(band.level).toBe('low');
    expect(band.fired).toEqual([]);
  });

  it('is critical when a tool can destroy, and says which rule said so', () => {
    const band = bandFor(
      report({
        surfaces: [surface([{ name: 'drop_db', effect: 'destructive' }])] as never,
      }),
    );
    expect(band.level).toBe('critical');
    expect(band.fired.map((rule) => rule.rule)).toContain(RISK_RULE.DESTRUCTIVE_TOOL);
  });

  it('is critical when a secret is reachable, which is the finding of the whole product', () => {
    const band = bandFor(
      report({
        resources: [
          { id: 'r1', sensitivity: 'secret', reachableBy: [{ id: 'agt_1' }] },
        ] as never,
      }),
    );
    expect(band.fired.map((rule) => rule.rule)).toContain(RISK_RULE.SECRET_REACHED);
    expect(band.level).toBe('critical');
  });

  it('raises a write tool when a credential sits beside it', () => {
    const withCredential = bandFor(
      report({
        surfaces: [
          surface([{ name: 'create_pr', effect: 'write' }], ['GITHUB_TOKEN']),
        ] as never,
      }),
    );
    expect(withCredential.fired.map((r) => r.rule)).toContain(
      RISK_RULE.WRITE_PLUS_CREDENTIAL,
    );
    expect(withCredential.level).toBe('high');
  });

  it('treats an unprobed server as unknown rather than harmless', () => {
    const band = bandFor(report({ surfaces: [surface([])] as never }));
    expect(band.fired.map((rule) => rule.rule)).toContain(RISK_RULE.UNPROBED_SERVER);
    expect(band.level).toBe('medium');
  });

  it('counts a shell, because it reaches everything the user can', () => {
    const band = bandFor(
      report({ reachability: [{ agentId: 'agt_1', viaShell: true }] as never }),
    );
    expect(band.fired.map((rule) => rule.rule)).toContain(RISK_RULE.SHELL_SURFACE);
  });

  it('flags egress only when there is something that could use it', () => {
    const unknown = {
      outbound: 'unknown',
      proxyVars: [],
      noProxy: [],
      sandbox: [],
      read: [],
    };
    expect(bandFor(report({ egress: unknown as never })).fired).toEqual([]);

    const withTools = bandFor(
      report({
        egress: unknown as never,
        surfaces: [surface([{ name: 'get_thing', effect: 'read' }])] as never,
      }),
    );
    expect(withTools.fired.map((rule) => rule.rule)).toContain(
      RISK_RULE.UNRESTRICTED_EGRESS,
    );
  });

  it('takes the strongest rule that fired, never a sum', () => {
    const band = bandFor(
      report({
        surfaces: [
          surface([
            { name: 'drop_db', effect: 'destructive' },
            { name: 'create_pr', effect: 'write' },
          ]),
        ] as never,
        reachability: [{ agentId: 'agt_1', viaShell: true }] as never,
      }),
    );
    expect(band.level).toBe('critical');
    expect(band.fired.length).toBeGreaterThan(1);
  });
});
