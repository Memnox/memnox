import {
  DISCOVERED_AGENT_KIND,
  SURFACE_KIND,
  type SurfaceKind,
} from './discovery.constants';
import type { Surface } from './surface';
import { isWrapped } from './wrap';

/**
 * What is holding one agent, seam by seam. Per agent rather than per machine, because a
 * wrapped Claude Code and an unwrapped Cursor average out to nothing anybody can act on.
 */
export const SEAM_STATE = {
  /** Something is in front of this surface now. */
  HELD: 'held',
  /** The seam exists and is not in place for this agent yet. */
  OPEN: 'open',
  /** This agent does not have that surface, so there is nothing to hold. */
  NOT_APPLICABLE: 'not-applicable',
} as const;

export type SeamState = (typeof SEAM_STATE)[keyof typeof SEAM_STATE];

export interface SeamCoverage {
  surface: SurfaceKind;
  state: SeamState;
  /** What is true, in one line. */
  detail: string;
  /** The command that closes it. Absent when there is nothing to do. */
  next?: string;
}

/**
 * Products launched from a dock icon, which `memnox run` cannot reach, though their
 * integrated terminal still inherits the login shell.
 */
const WINDOWED_KINDS: readonly string[] = [
  DISCOVERED_AGENT_KIND.CLAUDE_DESKTOP,
  DISCOVERED_AGENT_KIND.CURSOR,
  DISCOVERED_AGENT_KIND.VS_CODE,
  DISCOVERED_AGENT_KIND.CLINE,
];

export interface CoverageFacts {
  /** True when the interceptor directory comes first on the PATH this shell has. */
  interceptorsFirstOnPath: boolean;
  interceptorsInstalled: boolean;
  /** Hooks present in the repository the reader is standing in. */
  gitHooksInstalled: boolean;
  /** A kernel profile has been written for the rules in force. */
  osGuardWritten: boolean;
  /** Proxy variables are set in this environment, so egress is observed. */
  egressProxySet: boolean;
  /** The interceptor directory is on the login PATH, which a windowed app's terminal inherits. */
  loginPathConfigured: boolean;
  /**
   * At least one rule file is registered. A seam over an empty rule set forwards
   * everything, so reporting it held would be a reassuring lie.
   */
  rulesRegistered: boolean;
  /** This agent's own settings run the policy hook before its tool calls. */
  ownPolicyHook: boolean;
}

/** Its own tools, by the surface each belongs to, as that agent names them. */
type HookedTools = Partial<Record<SurfaceKind, string>>;

/**
 * What each agent's own hook API reports before a call runs, so the policy hook rules on it.
 * Cursor and Windsurf send no web fetch, so their network is left to the other seams.
 */
const OWN_HOOK_TOOLS: ReadonlyMap<string, HookedTools> = new Map<string, HookedTools>([
  [
    DISCOVERED_AGENT_KIND.CLAUDE_CODE,
    { filesystem: 'Read, Edit and Write', network: 'WebFetch', mcp: 'MCP tool call' },
  ],
  [DISCOVERED_AGENT_KIND.CODEX_CLI, { filesystem: 'patch', mcp: 'MCP tool call' }],
  [
    'gemini-cli',
    { filesystem: 'file read and write', network: 'web fetch', mcp: 'MCP tool call' },
  ],
  [
    DISCOVERED_AGENT_KIND.CURSOR,
    { filesystem: 'file read and write', mcp: 'MCP tool call' },
  ],
  ['windsurf', { filesystem: 'file read and write', mcp: 'MCP tool call' }],
]);

/** The tools its own hook holds, and none where the hook is absent or has no rules to apply. */
function ownHookTools(kind: string, facts: CoverageFacts): HookedTools {
  if (!facts.ownPolicyHook || !facts.rulesRegistered) return {};
  return OWN_HOOK_TOOLS.get(kind) ?? {};
}

/** Held by the agent's own hook, where that hook rules on this surface's tools. */
function hookSeam(surface: SurfaceKind, hooked: HookedTools): SeamCoverage | null {
  const tools = hooked[surface];
  if (tools === undefined) return null;
  return heldSeam(surface, `its own hook checks every ${tools}`);
}

export function coverageFor(
  kind: string,
  agentId: string,
  surfaces: readonly Surface[],
  facts: CoverageFacts,
): SeamCoverage[] {
  const own = surfaces.filter((surface) => surface.agentId === agentId);
  const has = (surface: SurfaceKind): boolean =>
    own.some((each) => each.kind === surface);
  const windowed = WINDOWED_KINDS.includes(kind);
  const hooked = ownHookTools(kind, facts);

  const coverage = [
    mcpCoverage(
      own.flatMap((surface) => surface.servers ?? []),
      facts,
      hooked,
    ),
    shellCoverage(has(SURFACE_KIND.SHELL), windowed, facts),
  ];
  if (has(SURFACE_KIND.GIT)) coverage.push(gitCoverage(facts));
  if (has(SURFACE_KIND.FILESYSTEM)) coverage.push(filesystemCoverage(facts, hooked));
  if (has(SURFACE_KIND.NETWORK)) {
    coverage.push(networkCoverage(windowed, facts, hooked));
  }
  return coverage;
}

function heldSeam(surface: SurfaceKind, detail: string): SeamCoverage {
  return { surface, state: SEAM_STATE.HELD, detail };
}

function openSeam(surface: SurfaceKind, detail: string, next?: string): SeamCoverage {
  return {
    surface,
    state: SEAM_STATE.OPEN,
    detail,
    ...(next === undefined ? {} : { next }),
  };
}

function inapplicableSeam(surface: SurfaceKind, detail: string): SeamCoverage {
  return { surface, state: SEAM_STATE.NOT_APPLICABLE, detail };
}

/** MCP is the one seam that needs no environment, because it is written into the config. */
function mcpCoverage(
  servers: readonly { command: string; args: readonly string[] }[],
  facts: CoverageFacts,
  hooked: HookedTools,
): SeamCoverage {
  const mcp = SURFACE_KIND.MCP;
  if (servers.length === 0) return inapplicableSeam(mcp, 'declares no MCP server');
  const wrapped = servers.filter(isWrapped).length;
  const routed = wrapped === servers.length && facts.rulesRegistered;
  // The proxy is named first where it holds, since it also sees a call the agent never reports.
  if (!routed) {
    const byHook = hookSeam(mcp, hooked);
    if (byHook !== null) return byHook;
  }
  if (wrapped < servers.length) {
    return openSeam(
      mcp,
      `${servers.length - wrapped} of ${servers.length} server(s) not routed through the proxy`,
      'memnox mcp wrap',
    );
  }
  // Routed is not governed: the proxy comes up and finds nothing to apply.
  if (!facts.rulesRegistered) {
    return openSeam(
      mcp,
      `all ${servers.length} server(s) routed, but no rule file is registered`,
      'memnox policy use',
    );
  }
  return heldSeam(mcp, `all ${servers.length} server(s) routed through the proxy`);
}

/**
 * The shell is where most of an agent's reach is, and the seam an environment carries.
 * A windowed product takes that environment from the login shell rather than from us.
 */
function shellCoverage(
  hasShell: boolean,
  windowed: boolean,
  facts: CoverageFacts,
): SeamCoverage {
  const shell = SURFACE_KIND.SHELL;
  if (!hasShell) return inapplicableSeam(shell, 'holds no shell here');
  if (!facts.interceptorsInstalled) {
    return openSeam(
      shell,
      'no interceptors installed, so every command runs unseen',
      'memnox protect --interceptors',
    );
  }
  if (windowed) return windowedShellCoverage(facts);
  if (!facts.interceptorsFirstOnPath) {
    return openSeam(
      shell,
      'interceptors installed but not ahead of the real binaries on PATH',
      'memnox run -- <agent>',
    );
  }
  if (!facts.rulesRegistered) {
    return openSeam(
      shell,
      'interceptors are on PATH, but no rule file is registered',
      'memnox policy use',
    );
  }
  return heldSeam(shell, 'interceptors are ahead of the real binaries on PATH');
}

/** For a windowed app the PATH that matters is the login shell's, which nothing we start reaches. */
function windowedShellCoverage(facts: CoverageFacts): SeamCoverage {
  if (facts.loginPathConfigured && facts.rulesRegistered) {
    return heldSeam(
      SURFACE_KIND.SHELL,
      'on your login PATH, so its integrated terminal meets the wrappers',
    );
  }
  return openSeam(
    SURFACE_KIND.SHELL,
    'not on your login PATH, and a windowed app takes no environment from here',
    'memnox protect --path, then restart the app',
  );
}

function gitCoverage(facts: CoverageFacts): SeamCoverage {
  if (facts.gitHooksInstalled) {
    return heldSeam(
      SURFACE_KIND.GIT,
      'hooks in this repository stop a push even off PATH',
    );
  }
  return openSeam(
    SURFACE_KIND.GIT,
    'no hook in this repository, so only the PATH wrapper is in front of git',
    'memnox protect --hooks',
  );
}

function filesystemCoverage(facts: CoverageFacts, hooked: HookedTools): SeamCoverage {
  if (facts.osGuardWritten) {
    return heldSeam(
      SURFACE_KIND.FILESYSTEM,
      'a kernel profile holds denied paths, whatever runs',
    );
  }
  const byHook = hookSeam(SURFACE_KIND.FILESYSTEM, hooked);
  if (byHook !== null) return byHook;
  return openSeam(
    SURFACE_KIND.FILESYSTEM,
    'covered by the shell wrapper only, so a raw binary is not stopped',
    'memnox protect --os-guard',
  );
}

function networkCoverage(
  windowed: boolean,
  facts: CoverageFacts,
  hooked: HookedTools,
): SeamCoverage {
  if (facts.egressProxySet) {
    return heldSeam(
      SURFACE_KIND.NETWORK,
      'outbound requests go through the egress proxy',
    );
  }
  const byHook = hookSeam(SURFACE_KIND.NETWORK, hooked);
  if (byHook !== null) return byHook;
  if (windowed) {
    return openSeam(
      SURFACE_KIND.NETWORK,
      'nothing observes outbound traffic; a windowed app takes no environment from here',
    );
  }
  return openSeam(
    SURFACE_KIND.NETWORK,
    'nothing observes outbound traffic',
    'memnox run -- <agent>',
  );
}

/** Held over what could be held. A count, so a partly wired agent reads as partly wired. */
export function coverageSummary(coverage: readonly SeamCoverage[]): {
  held: number;
  total: number;
} {
  const applicable = coverage.filter((each) => each.state !== SEAM_STATE.NOT_APPLICABLE);
  return {
    held: applicable.filter((each) => each.state === SEAM_STATE.HELD).length,
    total: applicable.length,
  };
}
