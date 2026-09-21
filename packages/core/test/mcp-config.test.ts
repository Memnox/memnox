import { describe, expect, it } from 'vitest';
import { readMcpServers } from '../src/discovery/detectors/mcp-config';

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
