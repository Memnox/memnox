import { basename } from 'node:path';

import { SESSION_VAR } from '../config/config';
import { ENV_AGENT_NAME } from '../gate/policy-sources';

/**
 * Whether a command on the interceptor PATH came from an agent or from the person at the
 * keyboard. The PATH line sits in a login profile so a dock-launched agent is governed,
 * which put every command somebody typed in their own terminal under the rules too.
 */

/** Set by an agent for everything it runs, so a child of it says so without a process walk. */
export const AGENT_ENV_MARKERS: readonly string[] = [
  SESSION_VAR,
  ENV_AGENT_NAME,
  'CLAUDECODE',
  'AI_AGENT',
  'CODEX_SANDBOX',
  'CURSOR_AGENT',
  'GEMINI_CLI',
];

/**
 * Agent executables, matched on argv0 or on the script a node or python launcher runs.
 * An IDE is not on it, because a person types in the terminal an IDE opens as well.
 */
export const AGENT_BINARIES: readonly string[] = [
  'claude',
  'codex',
  'cursor-agent',
  'gemini',
  'aider',
  'goose',
  'opencode',
  'hermes',
  'openclaw',
  'ruflo',
];

/** One ancestor of the command, nearest first, as its argv. */
export type AncestorArgv = readonly string[];

/** The marker or binary that named an agent, or null when a person ran it. */
export function agentBehind(
  env: NodeJS.ProcessEnv,
  ancestors: readonly AncestorArgv[],
): string | null {
  const marker = AGENT_ENV_MARKERS.find((name) => (env[name] ?? '').length > 0);
  if (marker !== undefined) return marker;
  for (const argv of ancestors) {
    const found = argv.slice(0, 2).map(executableName).find(isAgentBinary);
    if (found !== undefined) return found;
  }
  return null;
}

/** `/opt/homebrew/bin/codex.js` and `-zsh` both reduce to the name somebody would type. */
function executableName(arg: string): string {
  return basename(arg)
    .replace(/^-/, '')
    .replace(/\.(c|m)?js$/, '');
}

function isAgentBinary(name: string): boolean {
  return AGENT_BINARIES.includes(name);
}
