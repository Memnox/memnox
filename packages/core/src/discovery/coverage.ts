import {
  DISCOVERED_AGENT_KIND,
  SURFACE_KIND,
  type SurfaceKind,
} from './discovery.constants';
import type { Surface } from './surface';
import { PROXY_BINARY, WRAP_MARKER } from './wrap';

/**
 * What is actually holding one agent, right now, seam by seam.
 *
 * `doctor --wiring` answers this for the machine, which is the wrong grain the moment
 * there is more than one agent on it: a wrapped Claude Code and an unwrapped Cursor
 * average out to "partly wired", and nobody can act on that. This answers it per
 * agent, from the same facts, so the next command is about the product in front of you.
 */
export const SEAM_STATE = {
  /** Something is in front of this surface now. */
  HELD: 'held',
  /** The seam exists and is not in place for this agent yet. */
  OPEN: 'open',
  /** This agent does not have that surface, so there is nothing to hold. */
  NOT_HELD: 'not-applicable',
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
 * Products launched from a dock icon rather than a terminal. It matters: `memnox run`
 * sets the environment for a process it starts, and nothing it does reaches an app
 * somebody opened last Tuesday. Their integrated terminal still inherits the login
 * shell, which is the honest thing to tell somebody rather than "run it under memnox".
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
  /**
   * The interceptor directory is on the login PATH. This, not the PATH of the shell
   * running the command, is what a windowed app's integrated terminal inherits.
   */
  loginPathConfigured: boolean;
  /**
   * At least one rule file is registered, so a seam has something to decide with.
   * A seam in place over an empty rule set forwards everything, and reporting that
   * as held would be the same reassuring lie one level down.
   */
  rulesRegistered: boolean;
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

  const coverage: SeamCoverage[] = [];

  // MCP is the one seam that needs no environment: it is written into the config.
  const servers = own.flatMap((surface) => surface.servers ?? []);
  if (servers.length === 0) {
    coverage.push({
      surface: SURFACE_KIND.MCP,
      state: SEAM_STATE.NOT_HELD,
      detail: 'declares no MCP server',
    });
  } else {
    const wrapped = servers.filter(isWrapped).length;
    coverage.push(
      wrapped === servers.length
        ? facts.rulesRegistered
          ? {
              surface: SURFACE_KIND.MCP,
              state: SEAM_STATE.HELD,
              detail: `all ${servers.length} server(s) routed through the proxy`,
            }
          : {
              // Routed is not governed: the proxy comes up and finds nothing to apply.
              surface: SURFACE_KIND.MCP,
              state: SEAM_STATE.OPEN,
              detail: `all ${servers.length} server(s) routed, but no rule file is registered`,
              next: 'memnox policy use',
            }
        : {
            surface: SURFACE_KIND.MCP,
            state: SEAM_STATE.OPEN,
            detail: `${servers.length - wrapped} of ${servers.length} server(s) not routed through the proxy`,
            next: 'memnox mcp wrap',
          },
    );
  }

  coverage.push(shellCoverage(has(SURFACE_KIND.SHELL), windowed, facts));

  if (has(SURFACE_KIND.GIT)) {
    coverage.push(
      facts.gitHooksInstalled
        ? {
            surface: SURFACE_KIND.GIT,
            state: SEAM_STATE.HELD,
            detail: 'hooks in this repository stop a push even off PATH',
          }
        : {
            surface: SURFACE_KIND.GIT,
            state: SEAM_STATE.OPEN,
            detail:
              'no hook in this repository, so only the PATH wrapper is in front of git',
            next: 'memnox protect --hooks',
          },
    );
  }

  if (has(SURFACE_KIND.FILESYSTEM)) {
    coverage.push(
      facts.osGuardWritten
        ? {
            surface: SURFACE_KIND.FILESYSTEM,
            state: SEAM_STATE.HELD,
            detail: 'a kernel profile holds denied paths, whatever runs',
          }
        : {
            surface: SURFACE_KIND.FILESYSTEM,
            state: SEAM_STATE.OPEN,
            detail: 'covered by the shell wrapper only, so a raw binary is not stopped',
            next: 'memnox protect --os-guard',
          },
    );
  }

  if (has(SURFACE_KIND.NETWORK)) {
    coverage.push(
      facts.egressProxySet
        ? {
            surface: SURFACE_KIND.NETWORK,
            state: SEAM_STATE.HELD,
            detail: 'outbound requests go through the egress proxy',
          }
        : {
            surface: SURFACE_KIND.NETWORK,
            state: SEAM_STATE.OPEN,
            detail: windowed
              ? 'nothing observes outbound traffic; a windowed app takes no environment from here'
              : 'nothing observes outbound traffic',
            ...(windowed ? {} : { next: 'memnox run -- <agent>' }),
          },
    );
  }

  return coverage;
}

/**
 * The shell is where most of an agent's reach actually is, and it is the seam an
 * environment has to carry. For a windowed product that environment comes from the
 * login shell rather than from us, so the honest instruction is different.
 */
function shellCoverage(
  hasShell: boolean,
  windowed: boolean,
  facts: CoverageFacts,
): SeamCoverage {
  if (!hasShell) {
    return {
      surface: SURFACE_KIND.SHELL,
      state: SEAM_STATE.NOT_HELD,
      detail: 'holds no shell here',
    };
  }
  if (!facts.interceptorsInstalled) {
    return {
      surface: SURFACE_KIND.SHELL,
      state: SEAM_STATE.OPEN,
      detail: 'no interceptors installed, so every command runs unseen',
      next: 'memnox protect --interceptors',
    };
  }
  /* For a windowed app the PATH that matters is the login shell's, not this one's:
     its integrated terminal inherits the profile, and nothing we start reaches it. */
  if (windowed) {
    return facts.loginPathConfigured && facts.rulesRegistered
      ? {
          surface: SURFACE_KIND.SHELL,
          state: SEAM_STATE.HELD,
          detail: 'on your login PATH, so its integrated terminal meets the wrappers',
        }
      : {
          surface: SURFACE_KIND.SHELL,
          state: SEAM_STATE.OPEN,
          detail:
            'not on your login PATH, and a windowed app takes no environment from here',
          next: 'memnox protect --path, then restart the app',
        };
  }
  if (facts.interceptorsFirstOnPath) {
    return facts.rulesRegistered
      ? {
          surface: SURFACE_KIND.SHELL,
          state: SEAM_STATE.HELD,
          detail: 'interceptors are ahead of the real binaries on PATH',
        }
      : {
          surface: SURFACE_KIND.SHELL,
          state: SEAM_STATE.OPEN,
          detail: 'interceptors are on PATH, but no rule file is registered',
          next: 'memnox policy use',
        };
  }
  return {
    surface: SURFACE_KIND.SHELL,
    state: SEAM_STATE.OPEN,
    detail: 'interceptors installed but not ahead of the real binaries on PATH',
    next: 'memnox run -- <agent>',
  };
}

function isWrapped(server: { command: string; args: string[] }): boolean {
  return server.command === PROXY_BINARY || server.args.includes(WRAP_MARKER);
}

/** Held over what could be held. A count, so a partly wired agent reads as partly wired. */
export function coverageSummary(coverage: readonly SeamCoverage[]): {
  held: number;
  total: number;
} {
  const applicable = coverage.filter((each) => each.state !== SEAM_STATE.NOT_HELD);
  return {
    held: applicable.filter((each) => each.state === SEAM_STATE.HELD).length,
    total: applicable.length,
  };
}
