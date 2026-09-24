import { describe, expect, it } from 'vitest';
import {
  coverageFor,
  coverageSummary,
  SEAM_STATE,
  type CoverageFacts,
} from '../src/discovery/coverage';
import { SURFACE_KIND } from '../src/discovery/discovery.constants';
import { PROXY_BINARY, WRAP_MARKER } from '../src/discovery/wrap';
import type { Surface } from '../src/discovery/surface';

const NOTHING: CoverageFacts = {
  interceptorsInstalled: false,
  interceptorsFirstOnPath: false,
  gitHooksInstalled: false,
  osGuardWritten: false,
  egressProxySet: false,
  loginPathConfigured: false,
  rulesRegistered: true,
  ownPolicyHook: false,
};

const EVERYTHING: CoverageFacts = {
  interceptorsInstalled: true,
  interceptorsFirstOnPath: true,
  gitHooksInstalled: true,
  osGuardWritten: true,
  egressProxySet: true,
  loginPathConfigured: true,
  rulesRegistered: true,
  ownPolicyHook: true,
};

const surfaces = (kinds: string[], servers?: Surface['servers']): Surface[] =>
  kinds.map((kind) => ({
    agentId: 'agt_x',
    kind: kind as Surface['kind'],
    detectedFrom: '/config',
    ...(kind === SURFACE_KIND.MCP && servers !== undefined ? { servers } : {}),
  }));

const seam = (coverage: ReturnType<typeof coverageFor>, kind: string) =>
  coverage.find((each) => each.surface === kind);

describe('what is holding one agent', () => {
  it('names the seam that is open and the command that closes it', () => {
    const coverage = coverageFor(
      'codex-cli',
      'agt_x',
      surfaces([SURFACE_KIND.SHELL, SURFACE_KIND.GIT], []),
      { ...NOTHING, interceptorsInstalled: true },
    );

    expect(seam(coverage, 'shell')?.next).toBe('memnox run -- <agent>');
    expect(seam(coverage, 'git')?.next).toBe('memnox protect --hooks');
  });

  /* `memnox run` sets the environment for a process it starts. An app somebody opened
     from the dock last Tuesday never sees it, so telling them to run it is useless. */
  it('tells a windowed product the truth about its environment, not to use memnox run', () => {
    const coverage = coverageFor(
      'cursor',
      'agt_x',
      surfaces([SURFACE_KIND.SHELL, SURFACE_KIND.NETWORK]),
      { ...NOTHING, interceptorsInstalled: true },
    );

    expect(seam(coverage, 'shell')?.next).toContain('memnox protect --path');
    expect(seam(coverage, 'shell')?.next).not.toContain('memnox run');
    // Nothing here can set an environment variable for an app that is already running.
    expect(seam(coverage, 'network')?.next).toBeUndefined();
  });

  it('says the MCP seam is held only when every server is routed', () => {
    const half = surfaces(
      [SURFACE_KIND.MCP],
      [
        { name: 'a', command: PROXY_BINARY, args: [] },
        { name: 'b', command: 'npx', args: ['raw'] },
      ],
    );
    expect(seam(coverageFor('cursor', 'agt_x', half, NOTHING), 'mcp')).toMatchObject({
      state: SEAM_STATE.OPEN,
      detail: '1 of 2 server(s) not routed through the proxy',
      next: 'memnox mcp wrap',
    });

    const all = surfaces(
      [SURFACE_KIND.MCP],
      [
        { name: 'a', command: PROXY_BINARY, args: [] },
        // Marked rather than renamed: a wrapper that kept the name is still a wrapper.
        { name: 'b', command: 'npx', args: [WRAP_MARKER, '--', 'raw'] },
      ],
    );
    expect(seam(coverageFor('cursor', 'agt_x', all, NOTHING), 'mcp')?.state).toBe(
      SEAM_STATE.HELD,
    );
  });

  it('counts a surface the agent does not have as neither held nor open', () => {
    const coverage = coverageFor(
      'claude-desktop',
      'agt_x',
      surfaces([SURFACE_KIND.NETWORK]),
      NOTHING,
    );

    expect(seam(coverage, 'shell')?.state).toBe(SEAM_STATE.NOT_APPLICABLE);
    // One applicable seam, so the summary says one, not four.
    expect(coverageSummary(coverage)).toEqual({ held: 0, total: 1 });
  });

  it('reads as fully held once every seam is in place', () => {
    const coverage = coverageFor(
      'codex-cli',
      'agt_x',
      surfaces(
        [
          SURFACE_KIND.SHELL,
          SURFACE_KIND.GIT,
          SURFACE_KIND.FILESYSTEM,
          SURFACE_KIND.NETWORK,
          SURFACE_KIND.MCP,
        ],
        [{ name: 'a', command: PROXY_BINARY, args: [] }],
      ),
      EVERYTHING,
    );

    const { held, total } = coverageSummary(coverage);
    expect(held).toBe(total);
    expect(coverage.every((each) => each.next === undefined)).toBe(true);
  });

  /* Its integrated terminal inherits the login shell, so that is the PATH that
     decides — not the PATH of whatever shell happened to run this command. */
  it('counts a windowed app as held once the line is in the login profile', () => {
    const held = coverageFor('cursor', 'agt_x', surfaces([SURFACE_KIND.SHELL]), {
      ...NOTHING,
      interceptorsInstalled: true,
      loginPathConfigured: true,
    });

    expect(seam(held, 'shell')?.state).toBe(SEAM_STATE.HELD);
    expect(seam(held, 'shell')?.next).toBeUndefined();
  });

  it('asks for the interceptors first when none are installed', () => {
    const coverage = coverageFor(
      'hermes',
      'agt_x',
      surfaces([SURFACE_KIND.SHELL]),
      NOTHING,
    );

    expect(seam(coverage, 'shell')?.next).toBe('memnox protect --interceptors');
  });
});

describe('a seam with nothing to decide with', () => {
  /* The same reassuring lie one level down: the proxy is in front of every server and
     comes up with no rules, so it forwards everything it was installed to stop. */
  it('is open, not held, when no rule file is registered', () => {
    const coverage = coverageFor(
      'cursor',
      'agt_x',
      surfaces([SURFACE_KIND.MCP], [{ name: 'a', command: PROXY_BINARY, args: [] }]),
      { ...NOTHING, rulesRegistered: false },
    );

    expect(seam(coverage, 'mcp')).toMatchObject({
      state: SEAM_STATE.OPEN,
      next: 'memnox policy use',
    });
    expect(seam(coverage, 'mcp')?.detail).toContain('no rule file is registered');
  });
});

describe("an agent's own policy hook", () => {
  const every = surfaces(
    [SURFACE_KIND.FILESYSTEM, SURFACE_KIND.NETWORK, SURFACE_KIND.MCP],
    [{ name: 'github', command: 'npx', args: ['raw'] }],
  );

  /* setup writes the hook into Claude Code's own settings, so a Read of a secret or a
     WebFetch is ruled on with no wrapper in the way, and explain has to say so. */
  it('holds the file, fetch and MCP tools Claude Code reports to it', () => {
    const coverage = coverageFor('claude-code', 'agt_x', every, {
      ...NOTHING,
      ownPolicyHook: true,
    });

    expect(seam(coverage, 'filesystem')).toMatchObject({
      state: SEAM_STATE.HELD,
      detail: 'its own hook checks every Read, Edit and Write',
    });
    expect(seam(coverage, 'network')?.detail).toBe('its own hook checks every WebFetch');
    expect(seam(coverage, 'mcp')?.state).toBe(SEAM_STATE.HELD);
    expect(coverageSummary(coverage)).toEqual({ held: 3, total: 3 });
  });

  // Cursor's hooks see no web fetch, so its network stays with the other seams.
  it('holds only what that agent reports to its hook', () => {
    const coverage = coverageFor('cursor', 'agt_x', every, {
      ...NOTHING,
      ownPolicyHook: true,
    });

    expect(seam(coverage, 'filesystem')?.state).toBe(SEAM_STATE.HELD);
    expect(seam(coverage, 'network')?.state).toBe(SEAM_STATE.OPEN);
  });

  it('holds nothing where the hook is absent or has no rules to apply', () => {
    const absent = coverageFor('claude-code', 'agt_x', every, NOTHING);
    const empty = coverageFor('claude-code', 'agt_x', every, {
      ...NOTHING,
      ownPolicyHook: true,
      rulesRegistered: false,
    });

    expect(seam(absent, 'filesystem')?.detail).toContain('shell wrapper only');
    expect(coverageSummary(empty).held).toBe(0);
  });
});
