import { execFileSync } from 'node:child_process';
import {
  policiesFrom,
  POLICY_FILE_EXTENSION,
  recommendedAnswers,
  rememberRepository,
} from '@memnox/core';
import { installInterceptors, INTERCEPT_BINARY } from '@memnox/interceptors';
import { wrapEveryServer } from './commands/mcp.command';
import { installClaudeHook } from './protect/claude-hook';
import {
  installCodexHook,
  installCursorHook,
  installGeminiHook,
  installWindsurfHook,
} from './protect/agent-hooks';
import { mergeRules } from './protect/merge-rules';
import { installService } from './daemon/service';

/**
 * The things that turn an enrolled machine into a governed one.
 *
 * `setup` connected the machine and put its agents under Memnox, and then
 * stopped: no wrapper was in the path of any command, no rule had an opinion
 * about anything, and nothing pulled the workspace's rules unless somebody kept
 * a terminal open. So the guided run ended by saying the agents were under
 * Memnox while `scan` on the next line still said none of their capabilities
 * was governed. Onboarding is consent; this is the wiring that consent was for.
 *
 * Nothing here is new machinery. Each step calls what already owns it, which is
 * what makes `memnox uninstall` able to take all of them back out. One is the
 * lease Claude Code, Codex and Cursor take before they write a file: their own file
 * tools write from inside the agent and pass through no wrapper, so without it two
 * agents on one file never met. Another is the MCP proxy in front of each server, which is
 * where an outward action (the message, the issue, the deploy) is compared
 * against what another agent on another machine is about to do.
 */

export const WIRED = {
  DONE: 'done',
  /** The platform has no per-user service manager, which is not a failure. */
  UNSUPPORTED: 'unsupported',
  FAILED: 'failed',
} as const;

export type WiredState = (typeof WIRED)[keyof typeof WIRED];

export interface Wiring {
  /** Wrappers now in `~/.memnox/bin`. Zero means nothing is gated. */
  interceptors: number;
  /** Binaries a rule could cover that this machine does not have. */
  absent: number;
  rules: number;
  daemon: WiredState;
  /** Set when the service file was written but the manager would not take it. */
  daemonNote?: string;
  /** Whether Claude Code now takes a lease before it writes a file. */
  claudeHook: boolean;
  /**
   * The other coding agents that now take one too, by name. Each is hooked only
   * where it is installed, so this is empty on a machine with neither.
   */
  editHooks: string[];
  /** The repository the daemon now watches for edits by anything with no hooks. */
  watching?: string;
  /** MCP servers now reached through the proxy. */
  mcpServers: number;
  /** Set where the proxy is not on PATH, so wrapping would break the agents. */
  mcpUnwrapped?: true;
}

export interface WiringSeams {
  interceptors?: typeof installInterceptors;
  service?: typeof installService;
  /** Injected so a test writes no policy file into the directory it runs in. */
  rules?: (home: string, cwd: string) => Promise<number>;
  claudeHook?: (home: string) => Promise<boolean>;
  codexHook?: (home: string) => Promise<boolean>;
  cursorHook?: (home: string) => Promise<boolean>;
  geminiHook?: (home: string) => Promise<boolean>;
  windsurfHook?: (home: string) => Promise<boolean>;
  mcp?: (home: string, project: string) => Promise<{ wrapped: number; skipped: boolean }>;
}

/**
 * The baseline every machine should start with: destructive work denied, work
 * somebody else sees held for a person, reads left alone.
 *
 * Merged rather than written over, because a machine that already has rules is
 * the ordinary case on the second run and replacing them would be this command
 * quietly undoing somebody's edits.
 */
async function writeBaseline(home: string, cwd: string): Promise<number> {
  const policies = policiesFrom(recommendedAnswers());
  const path = `${cwd}/memnox.policies${POLICY_FILE_EXTENSION}`;
  await mergeRules(path, policies, home);
  return policies.length;
}

export async function wireMachine(
  home: string,
  cwd: string,
  seams: WiringSeams = {},
): Promise<Wiring> {
  const installed = await (seams.interceptors ?? installInterceptors)(
    home,
    INTERCEPT_BINARY,
  );
  const rules = await (seams.rules ?? writeBaseline)(home, cwd);
  const service = await (seams.service ?? installService)(home);
  const claudeHook = await (seams.claudeHook ?? installClaudeHook)(home);
  /* Codex and Cursor write files from inside themselves too, and an edit either
     makes on another computer met nothing until it had a hook of its own. */
  const codexHook = await (seams.codexHook ?? installCodexHook)(home);
  const cursorHook = await (seams.cursorHook ?? installCursorHook)(home);
  const geminiHook = await (seams.geminiHook ?? installGeminiHook)(home);
  const windsurfHook = await (seams.windsurfHook ?? installWindsurfHook)(home);
  const mcp = await (seams.mcp ?? wrapEveryServer)(home, cwd);
  /* The repository setup runs in is one agents here work in, so the daemon
     watches it for edits by anything with no hooks. */
  const root = repositoryOf(cwd);
  if (root !== null) rememberRepository(home, root);

  return {
    interceptors: installed.installed.length,
    absent: installed.absent.length,
    rules,
    daemon: daemonState(service),
    claudeHook,
    ...(root === null ? {} : { watching: root }),
    editHooks: [
      ...(codexHook ? ['Codex'] : []),
      ...(cursorHook ? ['Cursor'] : []),
      ...(geminiHook ? ['Gemini CLI'] : []),
      ...(windsurfHook ? ['Windsurf'] : []),
    ],
    mcpServers: mcp.wrapped,
    ...(mcp.skipped ? { mcpUnwrapped: true as const } : {}),
    ...(service.warning === undefined ? {} : { daemonNote: service.warning }),
  };
}

function daemonState(service: Awaited<ReturnType<typeof installService>>): WiredState {
  if (!service.state.supported) return WIRED.UNSUPPORTED;
  return service.state.installed ? WIRED.DONE : WIRED.FAILED;
}

/** The repository `cwd` is in, or null where it is in none. */
function repositoryOf(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // Not a repository, or no git: nothing to watch from here.
    return null;
  }
}
