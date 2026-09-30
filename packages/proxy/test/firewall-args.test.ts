import { describe, expect, it } from 'vitest';
import { parseFirewallArgs } from '../src/firewall-args';

const DEFAULT_NAME = 'mcp-server';

describe('parseFirewallArgs', () => {
  it('splits the server name from the wrapped command', () => {
    expect(
      parseFirewallArgs(['--name', 'github', '--', 'npx', '-y', '@mcp/github']),
    ).toEqual({
      serverName: 'github',
      command: ['npx', '-y', '@mcp/github'],
    });
  });

  it('keeps the wrapped command intact when it takes its own flags', () => {
    const args = parseFirewallArgs([
      '--name',
      'db',
      '--',
      'node',
      'server.js',
      '--port=1',
    ]);

    expect(args).toEqual({
      serverName: 'db',
      command: ['node', 'server.js', '--port=1'],
    });
  });

  it('accepts a bare command with no flags of ours', () => {
    expect(parseFirewallArgs(['--', 'npx', 'server'])).toEqual({
      serverName: DEFAULT_NAME,
      command: ['npx', 'server'],
    });
  });

  it('falls back to a default name when --name is absent', () => {
    expect(parseFirewallArgs(['--', 'npx'])).toEqual({
      serverName: DEFAULT_NAME,
      command: ['npx'],
    });
  });

  it('treats --name after the separator as the wrapped command, not ours', () => {
    const args = parseFirewallArgs(['--', 'npx', '--name', 'theirs']);

    expect(args).toEqual({
      serverName: DEFAULT_NAME,
      command: ['npx', '--name', 'theirs'],
    });
  });

  it('reads the agent the wrapped line was written for', () => {
    const args = parseFirewallArgs([
      '--memnox-wrapped',
      '--name',
      'slack',
      '--agent',
      'cursor',
      '--',
      'npx',
      '--agent',
      'theirs',
    ]);

    expect(args).toEqual({
      agent: 'cursor',
      serverName: 'slack',
      command: ['npx', '--agent', 'theirs'],
    });
    expect(parseFirewallArgs(['--name', 'slack', '--', 'npx'])).not.toHaveProperty(
      'agent',
    );
  });

  it('splits on the first separator so a later -- belongs to the command', () => {
    const args = parseFirewallArgs(['--name', 'x', '--', 'npx', '--', 'inner']);

    expect(args).toEqual({ serverName: 'x', command: ['npx', '--', 'inner'] });
  });
});

describe('parseFirewallArgs — unusable invocations', () => {
  it('rejects an invocation with no separator', () => {
    expect(parseFirewallArgs(['--name', 'github', 'npx'])).toBeNull();
  });

  it('rejects a separator with no command after it', () => {
    expect(parseFirewallArgs(['--name', 'github', '--'])).toBeNull();
  });

  it('rejects empty arguments', () => {
    expect(parseFirewallArgs([])).toBeNull();
  });
});

describe('parseFirewallArgs, a flag given no value', () => {
  it('names --name rather than taking the next flag as its value', () => {
    expect(parseFirewallArgs(['--name', '--agent', 'x', '--', 'cmd'])).toEqual({
      missingValueFor: '--name',
    });
  });

  it('names --name when it is the last of our arguments', () => {
    expect(parseFirewallArgs(['--name', '--', 'npx'])).toEqual({
      missingValueFor: '--name',
    });
  });

  it('names --agent the same way', () => {
    expect(parseFirewallArgs(['--agent', '--name', 'x', '--', 'cmd'])).toEqual({
      missingValueFor: '--agent',
    });
    expect(parseFirewallArgs(['--name', 'x', '--agent', '--', 'cmd'])).toEqual({
      missingValueFor: '--agent',
    });
  });
});
