import { describe, expect, it } from 'vitest';
import { parseGatewayArgs, type GatewayEnv } from '../src/index';

// Spelled out rather than imported: these names are the CLI's documented
// contract, so a rename should fail here rather than follow the constant.
const REQUIRED: GatewayEnv = {
  MEMNOX_MCP_UPSTREAM: 'https://mcp.internal/github',
  MEMNOX_URL: 'https://memnox.internal',
};

const parse = (argv: readonly string[] = [], env: GatewayEnv = REQUIRED) =>
  parseGatewayArgs(argv, env);

describe('parseGatewayArgs refuses to run ungoverned', () => {
  // A gateway that forwards everything is worse than none: it looks like protection.
  it('rejects a missing runtime url', () => {
    expect(parse([], { MEMNOX_MCP_UPSTREAM: 'https://mcp.internal' })).toBeNull();
  });

  it('rejects a missing upstream url', () => {
    expect(parse([], { MEMNOX_URL: 'https://memnox.internal' })).toBeNull();
  });

  it('rejects an empty value, which an unset shell variable expands to', () => {
    expect(parse([], { ...REQUIRED, MEMNOX_URL: '' })).toBeNull();
    expect(parse([], { ...REQUIRED, MEMNOX_MCP_UPSTREAM: '  ' })).toBeNull();
  });

  it('accepts an invocation with both urls present', () => {
    expect(parse()).toMatchObject({
      upstreamUrl: 'https://mcp.internal/github',
      runtimeUrl: 'https://memnox.internal',
    });
  });
});

describe('parseGatewayArgs names the server', () => {
  it('takes the name that follows --name', () => {
    expect(parse(['--name', 'github'])?.serverName).toBe('github');
  });

  it('falls back to a default when no name is given', () => {
    expect(parse([])?.serverName).toBe('mcp-server');
  });

  it('falls back when --name is last, rather than reading past the end', () => {
    expect(parse(['--name'])?.serverName).toBe('mcp-server');
  });

  // Otherwise the audit trail would name the server "--verbose".
  it('falls back when another flag follows --name', () => {
    expect(parse(['--name', '--verbose'])?.serverName).toBe('mcp-server');
  });
});

describe('parseGatewayArgs binds where it is told', () => {
  it('defaults to loopback, so a gateway is not exposed by accident', () => {
    const config = parse();

    expect(config?.host).toBe('127.0.0.1');
    expect(config?.port).toBe(8765);
  });

  it('takes the host and port from the environment', () => {
    const config = parse([], {
      ...REQUIRED,
      MEMNOX_MCP_GATEWAY_HOST: '0.0.0.0',
      MEMNOX_MCP_GATEWAY_PORT: '9100',
    });

    expect(config?.host).toBe('0.0.0.0');
    expect(config?.port).toBe(9100);
  });

  it('falls back to the default port when the value is not a number', () => {
    expect(parse([], { ...REQUIRED, MEMNOX_MCP_GATEWAY_PORT: 'nine' })?.port).toBe(8765);
  });

  it('falls back to the default port when the value is out of range', () => {
    expect(parse([], { ...REQUIRED, MEMNOX_MCP_GATEWAY_PORT: '-1' })?.port).toBe(8765);
    expect(parse([], { ...REQUIRED, MEMNOX_MCP_GATEWAY_PORT: '70000' })?.port).toBe(8765);
  });
});

describe('parseGatewayArgs reads the gate settings', () => {
  it('carries the tool filters through', () => {
    const config = parse([], {
      ...REQUIRED,
      MEMNOX_TOOLS_ALLOW: '^read_',
      MEMNOX_TOOLS_DENY: 'drop_',
    });

    expect(config?.allowPattern).toBe('^read_');
    expect(config?.denyPattern).toBe('drop_');
  });

  it('fails closed unless fail-open is spelled out exactly', () => {
    expect(parse()?.failOpen).toBe(false);
    expect(parse([], { ...REQUIRED, MEMNOX_MCP_FAIL_OPEN: 'TRUE' })?.failOpen).toBe(
      false,
    );
    expect(parse([], { ...REQUIRED, MEMNOX_MCP_FAIL_OPEN: '1' })?.failOpen).toBe(false);
    expect(parse([], { ...REQUIRED, MEMNOX_MCP_FAIL_OPEN: 'true' })?.failOpen).toBe(true);
  });

  // Kept apart from the caller's Memnox token, which must never reach the server.
  it('reads the upstream credential when one is configured', () => {
    const config = parse([], {
      ...REQUIRED,
      MEMNOX_MCP_UPSTREAM_AUTHORIZATION: 'Bearer upstream-only',
    });

    expect(config?.authorization).toBe('Bearer upstream-only');
    expect(parse()?.authorization).toBeUndefined();
  });
});
