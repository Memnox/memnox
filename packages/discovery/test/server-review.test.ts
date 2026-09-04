import { describe, expect, it } from 'vitest';
import { reviewServers } from '../src/server-review';
import {
  EFFECT_INFERENCE,
  FINDING_SEVERITY,
  SURFACE_KIND,
  TOOL_EFFECT,
} from '../src/discovery.constants';
import type { DiscoveryReport } from '../src/discover';

function tool(server: string, name: string, effect: string) {
  return {
    server,
    name,
    effect,
    inferredFrom: EFFECT_INFERENCE.NAME,
  };
}

function report(surface: unknown): DiscoveryReport {
  return { agents: [], surfaces: [surface], resources: [] } as unknown as DiscoveryReport;
}

const LAUNCH = { name: 'stripe', command: 'npx', args: ['stripe-mcp'] };

describe('reviewServers', () => {
  it('counts a server by effect rather than by tool count', () => {
    const [review] = reviewServers(
      report({
        agentId: 'claude-code',
        kind: SURFACE_KIND.MCP,
        detectedFrom: '~/.config/mcp.json',
        servers: [LAUNCH],
        tools: [
          tool('stripe', 'get_payment', TOOL_EFFECT.READ),
          tool('stripe', 'create_payment', TOOL_EFFECT.WRITE),
          tool('stripe', 'delete_customer', TOOL_EFFECT.DESTRUCTIVE),
        ],
      }),
    );
    expect(review?.read).toBe(1);
    expect(review?.write).toBe(1);
    expect(review?.destructive).toBe(1);
    expect(review?.risk).toBe(FINDING_SEVERITY.CRITICAL);
  });

  it('names the credentials the config hands it, and never a value', () => {
    const [review] = reviewServers(
      report({
        agentId: 'claude-code',
        kind: SURFACE_KIND.MCP,
        detectedFrom: '~/.config/mcp.json',
        servers: [{ ...LAUNCH, env: ['AWS_SECRET_ACCESS_KEY'] }],
        tools: [tool('stripe', 'create_payment', TOOL_EFFECT.WRITE)],
      }),
    );
    expect(review?.credentials).toEqual(['AWS_SECRET_ACCESS_KEY']);
    expect(review?.risk).toBe(FINDING_SEVERITY.HIGH);
  });

  it('marks a server nobody started as unprobed, never as harmless', () => {
    const [review] = reviewServers(
      report({
        agentId: 'claude-code',
        kind: SURFACE_KIND.MCP,
        detectedFrom: '~/.config/mcp.json',
        servers: [LAUNCH],
        tools: [],
      }),
    );
    expect(review?.unprobed).toBe(true);
    expect(review?.risk).toBe(FINDING_SEVERITY.MEDIUM);
  });

  it('notices filesystem and network reach from what the tools say they do', () => {
    const [review] = reviewServers(
      report({
        agentId: 'claude-code',
        kind: SURFACE_KIND.MCP,
        detectedFrom: '~/.config/mcp.json',
        servers: [LAUNCH],
        tools: [
          {
            ...tool('stripe', 'read_file', TOOL_EFFECT.READ),
            description: 'read a file',
          },
          {
            ...tool('stripe', 'fetch_url', TOOL_EFFECT.READ),
            description: 'http request',
          },
        ],
      }),
    );
    expect(review?.filesystem).toBe(true);
    expect(review?.network).toBe(true);
  });

  it('is empty when no config launches anything', () => {
    expect(
      reviewServers(
        report({
          agentId: 'claude-code',
          kind: SURFACE_KIND.MCP,
          detectedFrom: '~/.config/mcp.json',
        }),
      ),
    ).toEqual([]);
  });
});
