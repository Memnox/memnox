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

    expect(args?.command).toEqual(['node', 'server.js', '--port=1']);
  });

  it('accepts a bare command with no flags of ours', () => {
    expect(parseFirewallArgs(['--', 'npx', 'server'])).toEqual({
      serverName: DEFAULT_NAME,
      command: ['npx', 'server'],
    });
  });

  it('falls back to a default name when --name is absent', () => {
    expect(parseFirewallArgs(['--', 'npx'])?.serverName).toBe(DEFAULT_NAME);
  });

  it('falls back to a default name when --name is given no value', () => {
    expect(parseFirewallArgs(['--name', '--', 'npx'])?.serverName).toBe(DEFAULT_NAME);
  });

  it('treats --name after the separator as the wrapped command, not ours', () => {
    const args = parseFirewallArgs(['--', 'npx', '--name', 'theirs']);

    expect(args?.serverName).toBe(DEFAULT_NAME);
    expect(args?.command).toEqual(['npx', '--name', 'theirs']);
  });

  it('splits on the first separator so a later -- belongs to the command', () => {
    const args = parseFirewallArgs(['--name', 'x', '--', 'npx', '--', 'inner']);

    expect(args?.serverName).toBe('x');
    expect(args?.command).toEqual(['npx', '--', 'inner']);
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
