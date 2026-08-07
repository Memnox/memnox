import { execFileSync } from 'node:child_process';

/**
 * How the CLI reaches Graphify. An interface rather than a bare `execFileSync`
 * so tests drive the real command bodies without a subprocess or a network.
 */
export interface CommandRunner {
  /** Returns stdout, or null when the command is absent or exits non-zero. */
  run(command: string, args: readonly string[]): string | null;
}

const EXEC_MAX_BUFFER = 16 * 1024 * 1024;

export const processRunner: CommandRunner = {
  run: (command, args) => {
    try {
      return execFileSync(command, [...args], {
        encoding: 'utf8',
        maxBuffer: EXEC_MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      // Absent, or it failed — the caller decides which message that deserves.
      return null;
    }
  },
};

/** Graphify ships on PyPI under a different name than its command. */
const GRAPHIFY_COMMAND = 'graphify';
export const GRAPHIFY_PACKAGE = 'graphifyy';
export const GRAPHIFY_OUTPUT = 'graphify-out/graph.json';

/** Installers in preference order: isolated environments before a bare pip. */
const INSTALLERS: ReadonlyArray<{ command: string; args: readonly string[] }> = [
  { command: 'uv', args: ['tool', 'install', GRAPHIFY_PACKAGE] },
  { command: 'pipx', args: ['install', GRAPHIFY_PACKAGE] },
  { command: 'pip3', args: ['install', '--user', GRAPHIFY_PACKAGE] },
];

export function graphifyVersion(runner: CommandRunner): string | null {
  const output = runner.run(GRAPHIFY_COMMAND, ['--version']);
  return output === null ? null : output.trim();
}

interface InstallOutcome {
  installed: boolean;
  /** The installer that worked, or the ones tried when none did. */
  via?: string;
  attempted: string[];
}

/**
 * Installs Graphify. Only ever reached through `memnox graphify install`, so
 * running the command is the consent — nothing installs software as a side
 * effect of `memnox setup`.
 */
export function installGraphify(runner: CommandRunner): InstallOutcome {
  const attempted: string[] = [];
  for (const installer of INSTALLERS) {
    if (runner.run(installer.command, ['--version']) === null) continue;
    attempted.push(installer.command);
    if (runner.run(installer.command, installer.args) !== null) {
      return { installed: true, via: installer.command, attempted };
    }
  }
  return { installed: false, attempted };
}

/**
 * Re-extracts the code graph. `update` is the AST-only path: no LLM, no network,
 * no API key — which is the only kind of graph a deterministic gate may read.
 */
export function buildGraphifyGraph(runner: CommandRunner, root: string): boolean {
  return runner.run(GRAPHIFY_COMMAND, ['update', root, '--no-cluster']) !== null;
}
