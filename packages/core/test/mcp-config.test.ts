import { describe, expect, it } from 'vitest';
import { DEFAULT_DETECTORS } from '../src/discovery/detectors';
import {
  readMcpServers,
  URL_SERVER_COMMAND,
} from '../src/discovery/detectors/mcp-config';
import { FakeMachine } from './fake-machine';

describe('reading the servers a client config launches', () => {
  it('reads the mcpServers spelling most clients use', () => {
    const raw = JSON.stringify({ mcpServers: { github: { command: 'npx' } } });
    expect(readMcpServers(raw).map((server) => server.name)).toEqual(['github']);
  });

  it('reads the servers spelling VS Code uses', () => {
    const raw = JSON.stringify({ servers: { github: { command: 'npx' } } });
    expect(readMcpServers(raw).map((server) => server.name)).toEqual(['github']);
  });

  it('keeps env names and never their values', () => {
    const raw = JSON.stringify({
      mcpServers: { db: { command: 'pg', env: { TOKEN: 'shh', API_KEY: 'shh' } } },
    });
    expect(readMcpServers(raw)[0]?.env).toEqual(['API_KEY', 'TOKEN']);
    expect(JSON.stringify(readMcpServers(raw))).not.toContain('shh');
  });
});

/* Remote servers are the common case now, and the JSON reader skipped anything without a
   launch line; Claude Desktop's servers were read from the macOS path only; and servers
   added inside a Claude Code project were never read. Each under-reported reach. */
describe('servers the JSON reader used to miss', () => {
  it('reads a URL server, the way the TOML and YAML readers already did', () => {
    const raw = JSON.stringify({
      mcpServers: {
        linear: { type: 'http', url: 'https://mcp.linear.app/mcp' },
        gh: { command: 'npx' },
      },
    });
    const servers = readMcpServers(raw);
    expect(servers.map((server) => server.name)).toEqual(['linear', 'gh']);
    expect(servers[0]).toMatchObject({
      command: URL_SERVER_COMMAND,
      args: ['https://mcp.linear.app/mcp'],
    });
  });

  it('still skips an entry that declares neither a command nor a URL', () => {
    const raw = JSON.stringify({
      mcpServers: { broken: { args: ['x'] }, gh: { command: 'npx' } },
    });
    expect(readMcpServers(raw).map((server) => server.name)).toEqual(['gh']);
  });

  it('reads the servers a Claude Code project declares, beside the user-wide ones', () => {
    const raw = JSON.stringify({
      mcpServers: { github: { command: 'npx' } },
      projects: {
        '/work/api': { mcpServers: { postgres: { command: 'pg-mcp' } } },
        '/work/web': { mcpServers: { github: { command: 'npx' } } },
      },
    });
    // github twice, identically, is one server.
    expect(readMcpServers(raw).map((server) => server.name)).toEqual([
      'github',
      'postgres',
    ]);
  });

  it('reads a project server even when nothing is declared user-wide', () => {
    const raw = JSON.stringify({
      projects: { '/work/api': { mcpServers: { postgres: { command: 'pg-mcp' } } } },
    });
    expect(readMcpServers(raw).map((server) => server.name)).toEqual(['postgres']);
  });

  it('reads Claude Desktop’s servers from the Linux path when that is where they are', async () => {
    const desktop = DEFAULT_DETECTORS.find((each) => each.kind === 'claude-desktop');
    const machine = FakeMachine.from({
      '/home/dev/.config/Claude/claude_desktop_config.json': JSON.stringify({
        mcpServers: { files: { command: 'npx', args: ['-y', '@mcp/filesystem'] } },
      }),
    });

    const found = await desktop?.detect(machine, '2026-01-01T00:00:00.000Z');
    const mcp = found?.surfaces.find((surface) => surface.kind === 'mcp');

    expect(mcp?.servers?.map((server) => server.name)).toEqual(['files']);
  });
});
