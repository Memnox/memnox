import { describe, expect, it } from 'vitest';
import { combinedCapabilities, describeCombined } from '../src/discovery/composition';
import {
  EFFECT_INFERENCE,
  TOOL_EFFECT,
  type ToolEffect,
} from '../src/discovery/discovery.constants';
import type { McpTool } from '../src/discovery/surface';
import { runDoctor } from '../src/discovery/doctor';
import { bandFor } from '../src/discovery/risk';
import type { DiscoveryReport } from '../src/discovery/discover';

function tool(
  server: string,
  name: string,
  effect: ToolEffect = TOOL_EFFECT.READ,
): McpTool {
  return { server, name, effect, inferredFrom: EFFECT_INFERENCE.NAME };
}

describe('combined capability', () => {
  it('names the path three harmless tools make together', () => {
    const found = combinedCapabilities([
      tool('crm', 'read_customer'),
      tool('crm', 'create_customer_export', TOOL_EFFECT.WRITE),
      tool('slack', 'send_customer_file', TOOL_EFFECT.WRITE),
    ]);

    expect(found).toHaveLength(1);
    expect(found[0]?.subject).toBe('customer');
    expect(found[0]?.consequence).toBe('customer data can leave, in one session');
    expect(describeCombined(found[0] as (typeof found)[number])).toBe(
      'crm.read_customer → crm.create_customer_export → slack.send_customer_file',
    );
    // The whole reason this needs naming: reviewing the calls one at a time passes all three.
    expect(found[0]?.individuallyHarmless).toBe(true);
  });

  it('needs no packaging step, because plenty of tools send what they just read', () => {
    const found = combinedCapabilities([
      tool('vault', 'get_secret'),
      tool('http', 'post_secret', TOOL_EFFECT.WRITE),
    ]);

    expect(found[0]?.steps.map((each) => each.link)).toEqual(['acquire', 'emit']);
    expect(found[0]?.consequence).toBe(
      'a secret can be read and forwarded, in one session',
    );
  });

  it('says nothing when there is nowhere for the data to go', () => {
    expect(
      combinedCapabilities([
        tool('crm', 'read_customer'),
        tool('crm', 'list_customer_notes'),
      ]),
    ).toEqual([]);
  });

  it('says nothing when the two ends are about different things', () => {
    expect(
      combinedCapabilities([
        tool('crm', 'read_customer'),
        tool('ci', 'send_build_status', TOOL_EFFECT.WRITE),
      ]),
    ).toEqual([]);
  });

  it('is not fooled by a noun that merely contains a verb', () => {
    // "budget" contains "get", and a chain built on that would be an invention.
    expect(
      combinedCapabilities([tool('fin', 'budget'), tool('fin', 'post_budget')]),
    ).toEqual([]);
  });

  it('crosses servers, which is the case no single allow-list can see', () => {
    const found = combinedCapabilities([
      tool('postgres', 'query_user_table'),
      tool('email', 'send_user_digest', TOOL_EFFECT.WRITE),
    ]);

    expect(found[0]?.steps.map((each) => each.server)).toEqual(['postgres', 'email']);
  });

  it('marks a chain containing a destructive step as not individually harmless', () => {
    const found = combinedCapabilities([
      tool('crm', 'read_customer'),
      tool('crm', 'send_customer_report', TOOL_EFFECT.DESTRUCTIVE),
    ]);

    expect(found[0]?.individuallyHarmless).toBe(false);
  });
});

describe('the doctor, on a chain', () => {
  const chain = {
    agentId: 'agt_hermes',
    capabilities: combinedCapabilities([
      tool('crm', 'read_customer'),
      tool('slack', 'send_customer_file', TOOL_EFFECT.WRITE),
    ]),
  };

  it('offers the one change that breaks it: ask on the step that leaves', () => {
    const { findings } = runDoctor({
      resources: [],
      reachability: [],
      surfaces: [],
      chains: [chain],
      newId: () => 'fixed',
    });

    const found = findings.find((each) => each.title.includes('customer data can leave'));
    expect(found?.severity).toBe('high');
    expect(found?.evidence).toBe('crm.read_customer → slack.send_customer_file');
    // Asking on the emit step costs least: the read is what the agent is there to do.
    expect(found?.remediation?.apply.contents).toContain('mcp.slack.send_customer_file');
    expect(found?.remediation?.apply.contents).not.toContain('read_customer');
    /* The tool is not destructive and the rule must not say it is: somebody reads
       that file a year later and it has to still be true. */
    expect(found?.remediation?.description).toBe(
      'ask before 1 tool call that takes data off this machine',
    );
    expect(found?.remediation?.apply.path).not.toContain('destructive');
  });

  it('says nothing when a step in the chain is already destructive', () => {
    const destructive = {
      agentId: 'agt_hermes',
      capabilities: combinedCapabilities([
        tool('crm', 'read_customer'),
        tool('crm', 'send_customer_report', TOOL_EFFECT.DESTRUCTIVE),
      ]),
    };

    const { findings } = runDoctor({
      resources: [],
      reachability: [],
      surfaces: [],
      chains: [destructive],
      newId: () => 'fixed',
    });

    // It already has a destructive-tool finding; printing it twice teaches nothing.
    expect(findings.some((each) => each.title.includes('can leave'))).toBe(false);
  });

  it('raises the band, and names the rule that did it', () => {
    const band = bandFor({
      surfaces: [],
      resources: [],
      reachability: [],
      egress: {
        outbound: 'restricted',
        proxyVars: [],
        noProxy: [],
        sandbox: [],
        read: [],
      },
      combined: [chain],
    } as unknown as DiscoveryReport);

    expect(band.level).toBe('high');
    expect(band.fired.map((each) => each.rule)).toContain('combined-capability');
  });
});
