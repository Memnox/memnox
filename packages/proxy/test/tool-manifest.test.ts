import { describe, expect, it } from 'vitest';
import { LocalGate } from '@memnox/core';
import { LocalGateAuthorizer } from '../src/call-authorizer';
import { ToolManifest } from '../src/tool-manifest';

const CHANGES_REFUSED = [
  {
    name: 'mcp-changes',
    match: {
      actions: ['mcp.*'],
      classes: ['write', 'destructive', 'communication', 'unknown'],
    },
    decision: { effect: 'deny', reason: 'read only' },
  },
];

function authorizer(manifest: ToolManifest): LocalGateAuthorizer {
  const gate = new LocalGate(CHANGES_REFUSED as never, { agentName: 'agent' });
  return new LocalGateAuthorizer(gate, 'railway', 'ses_1', manifest);
}

describe('a call classified by what the server said about its tool', () => {
  it('trusts a read-only hint on a name that says nothing', async () => {
    const manifest = new ToolManifest();
    manifest.listed([{ name: 'deployments', annotations: { readOnlyHint: true } }]);
    const verdict = await authorizer(manifest).authorize({
      name: 'deployments',
      arguments: {},
    });
    expect(verdict.effect).toBe('allow');
  });

  it('believes a destructive hint over a name that sounds like a read', async () => {
    const manifest = new ToolManifest();
    manifest.listed([{ name: 'list_and_prune', annotations: { destructiveHint: true } }]);
    const verdict = await authorizer(manifest).authorize({
      name: 'list_and_prune',
      arguments: {},
    });
    expect(verdict.effect).toBe('deny');
  });

  it('falls back to the name before the server has listed anything', async () => {
    const verdict = await authorizer(new ToolManifest()).authorize({
      name: 'list_deployments',
      arguments: {},
    });
    expect(verdict.effect).toBe('allow');
  });
});
