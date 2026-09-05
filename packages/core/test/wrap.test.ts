import { describe, expect, it } from 'vitest';
import {
  planUnwrap,
  planWrap,
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
