import { basename } from 'node:path';

/**
 * What a shell was asked to do. `memnox run` sets this binary as `SHELL`, and an agent's
 * Bash tool then calls it the way it calls any shell — `$SHELL -c "<line>"`. Reading
 * argv as a command to spawn made that `spawn -c` and every command failed with ENOENT.
 */

export const SHELL_MODE = {
  /** `-c "<line>"`: the POSIX contract, and the only form an agent actually uses. */
  COMMAND: 'command',
  /** `-- cmd args`: how a person or a test drives the wrapper directly. */
  ARGV: 'argv',
  /** No command at all. Hand the terminal to the real shell rather than refuse it. */
  INTERACTIVE: 'interactive',
} as const;

export type ShellMode = (typeof SHELL_MODE)[keyof typeof SHELL_MODE];

export interface ShellInvocation {
  mode: ShellMode;
  /** The line to gate and to hand on unchanged, for the `-c` form. */
  line?: string;
  /** The command to gate and to spawn, for the `--` form. */
  argv?: string[];
  /** Flags seen before `-c`, so the real shell is invoked as it was asked to be. */
  flags: string[];
}

/** `-c`, and the combined forms a login or interactive shell arrives as: `-lc`, `-ic`. */
function commandFlag(argument: string): boolean {
  return /^-[a-z]*c$/.test(argument);
}

export function shellInvocation(argv: readonly string[]): ShellInvocation {
  const separator = argv.indexOf('--');
  if (separator !== -1) {
    return { mode: SHELL_MODE.ARGV, argv: [...argv.slice(separator + 1)], flags: [] };
  }

  const flags: string[] = [];
  for (const [index, argument] of argv.entries()) {
    if (commandFlag(argument)) {
      const line = argv[index + 1];
      if (line === undefined) break;
      return { mode: SHELL_MODE.COMMAND, line, flags };
    }
    if (argument.startsWith('-')) {
      flags.push(argument);
      continue;
    }
    // A bare word before any -c is a script path, which a shell runs as a command.
    return { mode: SHELL_MODE.ARGV, argv: [...argv.slice(index)], flags };
  }

  return { mode: SHELL_MODE.INTERACTIVE, flags };
}

export const REAL_SHELL_VAR = 'MEMNOX_REAL_SHELL';

/** The last shell that is not this one; `/bin/sh` exists on every machine this runs on. */
export const FALLBACK_SHELL = '/bin/sh';

/**
 * Never this binary. `memnox run` overwrites `SHELL`, so reading `SHELL` back here
 * would make the wrapper exec itself for ever — the same shape as the interceptor
 * fork bomb, and just as invisible until a terminal stops answering.
 */
export function realShell(env: NodeJS.ProcessEnv, self: string): string {
  const named = env[REAL_SHELL_VAR];
  if (named !== undefined && named !== '' && basename(named) !== basename(self)) {
    return named;
  }
  const inherited = env['SHELL'];
  if (
    inherited !== undefined &&
    inherited !== '' &&
    basename(inherited) !== basename(self)
  ) {
    return inherited;
  }
  return FALLBACK_SHELL;
}
