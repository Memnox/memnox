import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_INVENTORY_SCHEMA,
  INVENTORY_VERSION,
  inventoryOf,
} from '../src/discovery/inventory';
import type { DiscoveryReport } from '../src/discovery/discover';

const AWS_KEY = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');

const REPORT = {
  agents: [
    {
      id: 'agt_1',
      kind: 'claude-code',
      version: '1.2.0',
      configPaths: ['/home/dev/.claude.json'],
      clients: ['terminal'],
      ownerHint: 'dev',
      firstSeen: '2026-01-01T00:00:00.000Z',
    },
  ],
  surfaces: [
    {
      agentId: 'agt_1',
      kind: 'mcp',
      detectedFrom: '/home/dev/.claude.json',
      tools: [
        { server: 'github', name: 'merge_pull_request', effect: 'write' },
        { server: 'github', name: 'send_message', effect: 'write' },
      ],
      servers: [
        { name: 'github', command: 'npx', args: ['-y', 'gh-mcp'], env: ['GITHUB_TOKEN'] },
      ],
    },
  ],
  resources: [
    {
      id: 'res_1',
      kind: 'secret',
      path: '/home/dev/.aws/credentials',
      declaredIn: '/home/dev/.aws/credentials',
      fingerprint: 'ab12cd34',
      sensitivity: 'critical',
      reachableBy: [{ id: 'agt_1' }],
    },
  ],
  reachability: [{ agentId: 'agt_1', viaShell: true }],
  read: ['/home/dev/.aws/credentials'],
  probed: ['github: npx -y gh-mcp'],
  tools: [{ name: 'git', detectedFrom: '/usr/bin/git' }],
  egress: { outbound: 'unknown', proxyVars: [], noProxy: [], sandbox: [], read: [] },
  credentials: [],
  authenticated: [],
} as unknown as DiscoveryReport;

const TAKEN_AT = '2026-09-05T00:00:00.000Z';

describe('the capability inventory', () => {
  it('projects the scan into the shape that leaves the process', () => {
    const inventory = inventoryOf(REPORT, TAKEN_AT);

    expect(inventory.version).toBe(INVENTORY_VERSION);
    expect(inventory.agents[0]?.kind).toBe('claude-code');
    expect(inventory.mcpServers[0]).toMatchObject({
      name: 'github',
      declaredIn: '/home/dev/.claude.json',
      command: 'npx -y gh-mcp',
      credentials: ['GITHUB_TOKEN'],
      reachedBy: ['agt_1'],
      unprobed: false,
    });
    expect(inventory.shell).toEqual(['agt_1']);
    expect(inventory.git.map((binary) => binary.name)).toEqual(['git']);
  });

  it('classifies each tool, so a message tool is not filed as a plain write', () => {
    const inventory = inventoryOf(REPORT, TAKEN_AT);
    const byName = Object.fromEntries(
      inventory.tools.map((tool) => [tool.name, tool.class]),
    );
    expect(byName['merge_pull_request']).toBe('write');
    expect(byName['send_message']).toBe('communication');
  });

  it('carries a fingerprint and never a value, which is the rule that binds hardest', () => {
    const inventory = inventoryOf({ ...REPORT } as DiscoveryReport, TAKEN_AT);
    const serialized = JSON.stringify(inventory);

    expect(inventory.filesystem[0]?.fingerprint).toBe('ab12cd34');
    expect(serialized).not.toContain(AWS_KEY);
    expect(serialized).not.toContain('secret-value');
  });

  it('round-trips through JSON unchanged, because that is how it travels', () => {
    const inventory = inventoryOf(REPORT, TAKEN_AT);
    expect(JSON.parse(JSON.stringify(inventory))).toEqual(inventory);
  });

  it('publishes a schema whose required keys match the type it describes', () => {
    const inventory = inventoryOf(REPORT, TAKEN_AT);
    const required = [...CAPABILITY_INVENTORY_SCHEMA.required] as string[];

    expect(required.sort()).toEqual(Object.keys(inventory).sort());
    expect(CAPABILITY_INVENTORY_SCHEMA.properties.version.const).toBe(INVENTORY_VERSION);
  });

  it('marks a server nothing started as unprobed rather than as holding no tools', () => {
    const unprobed = {
      ...REPORT,
      surfaces: [{ ...REPORT.surfaces[0], tools: [] }],
    } as unknown as DiscoveryReport;

    expect(inventoryOf(unprobed, TAKEN_AT).mcpServers[0]?.unprobed).toBe(true);
  });
});
