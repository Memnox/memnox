import { describe, expect, it } from 'vitest';
import {
  planUnwrap,
  planUpgrade,
  planWrap,
  type ServerLaunch,
  PROXY_BINARY,
  serversKeyOf,
  unwrapLaunch,
  wrapLaunch,
} from '../src/discovery/wrap';

const GITHUB = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] };

describe('wrapping an MCP server', () => {
  it('repoints the launch at the proxy and keeps the original verbatim', () => {
    const wrapped = wrapLaunch('github', GITHUB);
    expect(wrapped.command).toBe(PROXY_BINARY);
    expect(wrapped.args).toEqual([
      '--memnox-wrapped',
      '--name',
      'github',
      '--',
      'npx',
      '-y',
      '@modelcontextprotocol/server-github',
    ]);
  });

  /* A server is started by the agent with that agent's environment, which says
     nothing about who it is. Written into the line, the proxy can name it. */
  it('names the agent whose config it is, and still round-trips', () => {
    const wrapped = wrapLaunch('github', GITHUB, 'claude-code');
    expect(wrapped.args.slice(0, 6)).toEqual([
      '--memnox-wrapped',
      '--name',
      'github',
      '--agent',
      'claude-code',
      '--',
    ]);
    expect(unwrapLaunch(wrapped)).toEqual(GITHUB);
    expect(planWrap({ github: GITHUB }, 'cursor').wrap[0]?.after.args).toContain(
      'cursor',
    );
  });

  /* A machine wrapped by an older version names no agent, and `setup` fixes
     that itself rather than asking for an unwrap and a wrap by hand. */
  it('rewrites an old wrapped line with the agent, keeping the server verbatim', () => {
    const old = wrapLaunch('github', GITHUB);
    const [upgrade] = planUpgrade({ github: old, plain: GITHUB }, 'cursor');

    expect(upgrade?.name).toBe('github');
    expect(upgrade?.after.args).toContain('cursor');
    expect(unwrapLaunch(upgrade?.after ?? old)).toEqual(GITHUB);
    expect(
      planUpgrade({ github: wrapLaunch('github', GITHUB, 'cursor') }, 'cursor'),
    ).toEqual([]);
    expect(planUpgrade({ github: old }, undefined)).toEqual([]);
  });

  it('round-trips, which is the whole promise of unwrap', () => {
    expect(unwrapLaunch(wrapLaunch('github', GITHUB))).toEqual(GITHUB);
  });

  it('keeps the credentials the config handed the server', () => {
    const withEnv = { ...GITHUB, env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } };
    const wrapped = wrapLaunch('github', withEnv);
    expect(wrapped.env).toEqual(withEnv.env);
    expect(unwrapLaunch(wrapped)).toEqual(withEnv);
  });

  it('never nests a wrap, because a doubly-proxied server starts nothing', () => {
    const plan = planWrap({ github: wrapLaunch('github', GITHUB) });
    expect(plan.wrap).toEqual([]);
    expect(plan.alreadyWrapped).toEqual(['github']);
  });

  it('leaves a line it did not write completely alone', () => {
    expect(unwrapLaunch(GITHUB)).toBeNull();
    const { restore, untouched } = planUnwrap({ github: GITHUB });
    expect(restore).toEqual([]);
    expect(untouched).toEqual(['github']);
  });

  it('plans both directions over a mixed config', () => {
    const servers = { github: GITHUB, slack: wrapLaunch('slack', GITHUB) };
    expect(planWrap(servers).wrap.map((each) => each.name)).toEqual(['github']);
    expect(planUnwrap(servers).restore.map((each) => each.name)).toEqual(['slack']);
  });

  it('finds where each client keeps its servers, since no two agree', () => {
    expect(serversKeyOf({ mcpServers: {} })).toBe('mcpServers');
    expect(serversKeyOf({ servers: {} })).toBe('servers');
    expect(serversKeyOf({ somethingElse: {} })).toBeNull();
  });
});

/**
 * A server declared by URL has no command to put a proxy in front of.
 *
 * `readConfigs` casts parsed JSON straight to `ServerLaunch`, which promises a
 * `command` and an `args`; an MCP config is under no obligation to agree. A
 * remote server is `{ type, url, headers }` and has neither, so
 * `launch.args.includes(...)` threw and took both `mcp wrap` and `mcp unwrap`
 * with it — on the very entry Memnox writes for its own cloud server.
 */
describe('an entry there is nothing to launch', () => {
  const url = {
    type: 'http',
    url: 'https://example.test/mcp',
  } as unknown as ServerLaunch;
  const stdio: ServerLaunch = { command: 'npx', args: ['some-server'] };

  it('does not throw when planning a wrap', () => {
    expect(() => planWrap({ remote: url })).not.toThrow();
  });

  it('does not throw when planning an unwrap', () => {
    expect(() => planUnwrap({ remote: url })).not.toThrow();
  });

  it('leaves it alone rather than rewriting it into something that cannot start', () => {
    const plan = planWrap({ remote: url, local: stdio });

    expect(plan.wrap.map((each) => each.name)).toEqual(['local']);
    expect(plan.alreadyWrapped).toEqual([]);
  });

  it('reports it as untouched when unwrapping', () => {
    const { restore, untouched } = planUnwrap({ remote: url });

    expect(restore).toEqual([]);
    expect(untouched).toEqual(['remote']);
  });

  /* An entry with a command and no args is the other half of the same shape. */
  it('survives a command with no arguments at all', () => {
    const bare = { command: 'my-server' } as unknown as ServerLaunch;

    expect(() => planUnwrap({ bare })).not.toThrow();
    expect(planUnwrap({ bare }).untouched).toEqual(['bare']);
  });
});
