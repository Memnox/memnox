import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
import type { DiscoveryReport } from '../src/discovery/discover';
import { SURFACE_KIND } from '../src/discovery/discovery.constants';
import { MCP_TRANSPORT, snapshotOf } from '../src/discovery/snapshot';
import { wrapLaunch } from '../src/discovery/wrap';
import { PolicyEngine } from '../src/policy/policy-engine';
import type { Policy } from '../src/policy/policy';
import {
  PolicyValidationError,
  validatePolicyDocument,
} from '../src/policy/policy-validator';

const NOW = '2026-09-01T09:00:00.000Z';

/** Only the fields `snapshotOf` reads, so the test says which ones matter. */
function reportOf(surfaces: DiscoveryReport['surfaces']): DiscoveryReport {
  return {
    agents: [],
    surfaces,
    resources: [],
    harnesses: [],
  } as unknown as DiscoveryReport;
}

const bare = {
  name: 'stripe',
  command: 'npx',
  args: ['stripe-mcp', '--key', 'sk_live_x'],
};

describe('a server in the snapshot says whether it is governed', () => {
  it('is wrapped only when every agent launches it through the proxy', () => {
    const wrapped = { name: 'stripe', ...wrapLaunch('stripe', bare) };
    const snapshot = snapshotOf(
      reportOf([
        {
          agentId: 'claude-code',
          kind: SURFACE_KIND.MCP,
          detectedFrom: '/home/dev/.claude.json',
          servers: [wrapped],
        },
        {
          agentId: 'cursor',
          kind: SURFACE_KIND.MCP,
          detectedFrom: '/home/dev/.cursor/mcp.json',
          servers: [bare],
        },
      ]),
      NOW,
    );

    expect(snapshot.servers).toEqual([
      expect.objectContaining({
        name: 'stripe',
        agentIds: ['claude-code', 'cursor'],
        wrapped: false,
        transport: MCP_TRANSPORT.STDIO,
      }),
    ]);
  });

  it('names a server reached by URL as http, and keeps the URL itself out', () => {
    const snapshot = snapshotOf(
      reportOf([
        {
          agentId: 'codex',
          kind: SURFACE_KIND.MCP,
          detectedFrom: '/home/dev/.codex/config.toml',
          servers: [
            { name: 'linear', command: 'http', args: ['https://mcp.test/?token=t'] },
          ],
        },
      ]),
      NOW,
    );

    expect(snapshot.servers[0]).toMatchObject({ transport: MCP_TRANSPORT.HTTP });
    expect(JSON.stringify(snapshot)).not.toContain('token=');
  });
});

const denyPush: Policy = {
  name: 'no-push',
  match: {
    actions: ['git.push'],
    unless: [{ agents: ['release-bot'] }, { workingDirectories: ['*/sandbox'] }],
  },
  decision: { effect: DECISION_EFFECT.DENY },
};

describe('a rule stands aside where an exception was approved', () => {
  const engine = new PolicyEngine([denyPush]);

  it('does not reach the agent the exception names', () => {
    const verdict = engine.evaluate({ action: 'git.push' }, { agentName: 'release-bot' });

    expect(verdict.effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('still reaches every other agent', () => {
    const verdict = engine.evaluate({ action: 'git.push' }, { agentName: 'claude-code' });

    expect(verdict.effect).toBe(DECISION_EFFECT.DENY);
  });

  it('keeps the rule where the request is outside every carve-out', () => {
    const unreported = engine.evaluate(
      { action: 'git.push' },
      { agentName: 'claude-code' },
    );
    const elsewhere = engine.evaluate(
      { action: 'git.push', workingDirectory: '/srv/api' },
      { agentName: 'claude-code' },
    );

    expect(unreported.effect).toBe(DECISION_EFFECT.DENY);
    expect(elsewhere.effect).toBe(DECISION_EFFECT.DENY);
  });

  it('stands aside in the repository the exception names', () => {
    const verdict = engine.evaluate(
      { action: 'git.push', workingDirectory: '/home/dev/sandbox' },
      { agentName: 'claude-code' },
    );

    expect(verdict.effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('keeps a project carve-out closed while no project is reported', () => {
    const scoped = new PolicyEngine([
      { ...denyPush, match: { actions: ['git.push'], unless: [{ project: 'api' }] } },
    ]);

    expect(scoped.evaluate({ action: 'git.push' }, { agentName: 'x' }).effect).toBe(
      DECISION_EFFECT.DENY,
    );
    expect(
      scoped.evaluate({ action: 'git.push', projectId: 'api' }, { agentName: 'x' })
        .effect,
    ).toBe(DECISION_EFFECT.ALLOW);
  });
});

describe('a carve-out as a rule file carries it', () => {
  const document = (unless: unknown) => ({
    version: 1,
    policies: [
      {
        name: 'no-push',
        match: { actions: ['git.push'], unless },
        decision: { effect: 'deny' },
      },
    ],
  });

  it('is read into the rule', () => {
    const parsed = validatePolicyDocument(document([{ agents: ['release-bot'] }]));

    expect(parsed.policies[0]?.match.unless).toEqual([{ agents: ['release-bot'] }]);
  });

  it('is refused when it names nothing, since that would void the rule everywhere', () => {
    expect(() => validatePolicyDocument(document([{}]))).toThrow(PolicyValidationError);
  });
});
