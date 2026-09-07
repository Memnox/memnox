import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { DISCOVERED_AGENT_KIND } from '@memnox/core';

/**
 * Whether a binary is on PATH, walked here rather than asked of a shell. `command -v`
 * under `shell: true` is a Node deprecation warning printed over the command's own
 * output, and spawning a shell to answer a question about the filesystem was never
 * worth a process either way.
 */
export function onPath(binary: string, path = process.env['PATH'] ?? ''): boolean {
  // An explicit path is not a PATH lookup: the caller already said where it is.
  if (binary.includes('/')) return executable(binary);
  return path
    .split(delimiter)
    .some((entry) => entry !== '' && executable(join(entry, binary)));
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
 * What an agent's binary is called, for the kinds whose binary is not their name.
 *
 * The scan prints `claude-code` and the executable is `claude`, so the obvious thing
 * to type after reading one screen is the one thing that cannot work. Naming it is
 * the whole fix: guessing on the reader's behalf would start a different program from
 * the one they asked for.
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
