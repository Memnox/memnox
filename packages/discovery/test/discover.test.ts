import { describe, expect, it } from 'vitest';
import { discover, summarize } from '../src/discover';
import { SENSITIVITY, SURFACE_KIND } from '../src/discovery.constants';
import { FakeMachine } from './fake-machine';

const NOW = '2026-08-31T09:00:00.000Z';

const CLAUDE_CONFIG = JSON.stringify({
  mcpServers: {
    github: { command: 'npx', args: ['-y', 'github-mcp'] },
    postgres: { command: 'uvx', args: ['postgres-mcp'] },
  },
});

const MACHINE = {
  '/home/dev/.claude.json': CLAUDE_CONFIG,
  '/home/dev/.cursor/mcp.json': CLAUDE_CONFIG,
  '/home/dev/.aws/credentials': '[default]\naws_access_key_id = AKIAEXAMPLE',
  '/home/dev/.ssh/id_ed25519': 'PRIVATE KEY MATERIAL',
  '/var/run/docker.sock': '',
};

describe('discover', () => {
  it('names the agent kinds already on the machine, with the file that proved each', async () => {
    const report = await discover(FakeMachine.from(MACHINE), { now: NOW });

    expect(report.agents.map((agent) => agent.kind).sort()).toEqual([
      'claude-code',
      'cursor',
    ]);
    expect(report.agents[0]?.configPaths).toContain('/home/dev/.claude.json');
  });

  it('never stores a secret value, only a path, a kind and a fingerprint', async () => {
    const report = await discover(FakeMachine.from(MACHINE), { now: NOW });
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain('AKIAEXAMPLE');
    expect(serialized).not.toContain('PRIVATE KEY MATERIAL');
    const aws = report.resources.find((each) => each.path?.endsWith('.aws/credentials'));
    expect(aws?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(aws?.sensitivity).toBe(SENSITIVITY.CRITICAL);
  });

  it('prints what it opened and why, so the credential scan is itself inspectable', async () => {
    const report = await discover(FakeMachine.from(MACHINE), { now: NOW });

    expect(report.read).toContain('/home/dev/.aws/credentials');
    expect(report.read).toContain('/home/dev/.ssh/id_ed25519');
  });

  it('short-circuits reachability through a shell surface', async () => {
    const report = await discover(FakeMachine.from(MACHINE), { now: NOW });
    const claude = report.reachability.find((each) => each.agentId === 'agt_claude-code');

    expect(claude?.viaShell).toBe(true);
    expect(claude?.surfaces).toContain(SURFACE_KIND.SHELL);
    // The docker socket is reachable only because a shell is, which is the point.
    expect(claude?.resources.some((each) => each.kind === 'socket')).toBe(true);
  });

  it('says nothing rather than something when the machine holds no agent', async () => {
    const report = await discover(FakeMachine.from({}), { now: NOW });

    expect(report.agents).toEqual([]);
    expect(summarize(report)).toEqual({
      agents: 0,
      surfaces: 0,
      tools: 0,
      reachableSecrets: 0,
    });
  });

  it('attributes each reachable secret to the agents that can reach it', async () => {
    const report = await discover(FakeMachine.from(MACHINE), { now: NOW });
    const ssh = report.resources.find((each) => each.path?.endsWith('id_ed25519'));

    expect(ssh?.reachableBy.map((ref) => ref.kind).sort()).toEqual([
      'claude-code',
      'cursor',
    ]);
  });
});
