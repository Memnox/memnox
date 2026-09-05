import { describe, expect, it } from 'vitest';
import { renderShareCard, shareCardFor } from '../src/discovery/share-card';
import type { CapabilityInventory } from '../src/discovery/inventory';

const INVENTORY = {
  version: 1,
  takenAt: '2026-09-05T10:00:00.000Z',
  agents: [{ id: 'agt_1', kind: 'claude-code', configPaths: [], clients: [] }],
  mcpServers: [
    {
      name: 'github-internal-tooling',
      declaredIn: '/Users/someone/.claude.json',
      command: 'npx -y @acme/private-mcp',
      credentials: ['ACME_TOKEN'],
      reachedBy: ['agt_1'],
      unprobed: false,
    },
  ],
  tools: [
    {
      server: 'github-internal-tooling',
      name: 'merge_pull_request',
      class: 'write',
      from: 'name',
    },
    { server: 'github-internal-tooling', name: 'get_issue', class: 'read', from: 'name' },
    {
      server: 'github-internal-tooling',
      name: 'send_message',
      class: 'communication',
      from: 'name',
    },
  ],
  filesystem: [
    {
      path: '/Users/someone/.ssh/id_ed25519',
      sensitivity: 'critical',
      reachableBy: ['agt_1'],
    },
    {
      path: '/Users/someone/projects/acme-secret-project/README.md',
      sensitivity: 'ordinary',
      reachableBy: ['agt_1'],
    },
  ],
  shell: ['agt_1'],
  git: [],
  credentials: [
    {
      name: 'ACME_TOKEN',
      declaredIn: '/Users/someone/.claude.json',
      reachableBy: ['agt_1'],
    },
  ],
  network: { outbound: 'unknown', proxyVars: [], noProxy: [], sandbox: [], read: [] },
} as unknown as CapabilityInventory;

describe('the share card', () => {
  it('counts what somebody would actually want to show', () => {
    expect(shareCardFor(INVENTORY)).toEqual({
      agents: 1,
      servers: 1,
      tools: 3,
      externalState: 2,
      sensitivePathsReachable: 1,
      credentialsReachable: 1,
      shellSurfaces: 1,
    });
  });

  it('counts communication as changing external state, because the data has left', () => {
    expect(shareCardFor(INVENTORY).externalState).toBe(2);
  });

  it('leaks nothing — no path, no server name, no credential name, no username', () => {
    const rendered = renderShareCard(shareCardFor(INVENTORY));
    for (const secret of [
      'id_ed25519',
      '.ssh',
      'github-internal-tooling',
      'acme-secret-project',
      'ACME_TOKEN',
      'someone',
      '/Users',
    ]) {
      expect(rendered).not.toContain(secret);
    }
  });

  it('says it is counts only, so a reader knows what they are pasting', () => {
    const rendered = renderShareCard(shareCardFor(INVENTORY));
    expect(rendered).toContain('Counts only');
    expect(rendered).toContain('npx memnox');
  });

  it('renders an honest card on a machine with nothing on it', () => {
    const empty = {
      ...INVENTORY,
      agents: [],
      mcpServers: [],
      tools: [],
      filesystem: [],
      shell: [],
      credentials: [],
    };
    const rendered = renderShareCard(shareCardFor(empty as CapabilityInventory));
    expect(rendered).toContain('AI agents installed');
    expect(rendered).toContain('0');
  });
});
