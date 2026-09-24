import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { DISCOVERED_AGENT_KIND } from '@memnox/core';

/**
 * Whether a binary is on PATH, walked here rather than asked of a shell: `command -v`
 * under `shell: true` prints a Node deprecation warning over the command's own output.
 */
export function onPath(
  binary: string,
  path = process.env['PATH'] ?? '',
  isFound: (candidate: string) => boolean = executable,
): boolean {
  // An explicit path is not a PATH lookup: the caller already said where it is.
  if (binary.includes('/')) return isFound(binary);
  return path
    .split(delimiter)
    .some((entry) => entry !== '' && isFound(join(entry, binary)));
}

function executable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    // Not here, which is the ordinary case for all but one entry on the list.
    return false;
  }
}

/**
 * What an agent's binary is called, where it is not the agent's own name: the scan
 * prints `claude-code` and the executable is `claude`.
 */
const BINARY_FOR: Record<string, string> = {
  [DISCOVERED_AGENT_KIND.CLAUDE_CODE]: 'claude',
  [DISCOVERED_AGENT_KIND.CODEX_CLI]: 'codex',
  [DISCOVERED_AGENT_KIND.CLAUDE_DESKTOP]: 'claude',
};

/** The binary somebody meant, when the name they typed is an agent kind and not one. */
export function binaryMeantBy(name: string): string | null {
  const binary = BINARY_FOR[name];
  return binary === undefined || !onPath(binary) ? null : binary;
}
