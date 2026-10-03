import { basename } from 'node:path';

/**
 * What a shell was asked to do. `memnox run` sets this binary as `SHELL`, and an agent's
 * Bash tool then calls it the way it calls any shell, as `$SHELL -c "<line>"`.
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
  /** The words after the `-c` line, which the shell reads as `$0`, `$1` and on. */
  positional?: string[];
  /** The command to gate and to spawn, for the `--` form. */
  argv?: string[];
  /** Flags seen before `-c`, so the real shell is invoked as it was asked to be. */
  flags: string[];
}

/** Options whose next word is their value rather than a script path. */
const OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  '-o',
  '+o',
  '-O',
  '+O',
  '--rcfile',
  '--init-file',
]);

/** `-c`, and the combined forms a login or interactive shell arrives as: `-lc`, `-ic`. */
function isCommandFlag(argument: string): boolean {
  return /^-[a-z]*c$/.test(argument);
}

export function parseShellInvocation(argv: readonly string[]): ShellInvocation {
  const flags: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    // Only a `--` ahead of any -c ends the options, since after the line it is `$0`.
    if (argument === '--') {
      return { mode: SHELL_MODE.ARGV, argv: [...argv.slice(index + 1)], flags: [] };
    }
    if (isCommandFlag(argument)) {
      const line = argv[index + 1];
      if (line === undefined) break;
      return {
        mode: SHELL_MODE.COMMAND,
        line,
        positional: [...argv.slice(index + 2)],
        flags,
      };
    }
    if (OPTIONS_WITH_VALUE.has(argument)) {
      const value = argv[index + 1];
      flags.push(...(value === undefined ? [argument] : [argument, value]));
      index += 1;
      continue;
    }
    if (argument.startsWith('-') || argument.startsWith('+')) {
      flags.push(argument);
      continue;
    }
    // A bare word before any -c is a script path, which a shell runs as a command.
    return { mode: SHELL_MODE.ARGV, argv: [...argv.slice(index)], flags };
  }

  return { mode: SHELL_MODE.INTERACTIVE, flags };
}

/** The real shell's argv for the `-c` form, positionals kept so `$0` and `$1` survive. */
export function commandShellArgs(invocation: ShellInvocation): string[] {
  return [
    ...invocation.flags,
    '-c',
    invocation.line ?? '',
    ...(invocation.positional ?? []),
  ];
}

export const REAL_SHELL_VAR = 'MEMNOX_REAL_SHELL';

/**
 * The last shell that is not this one; `/bin/sh` exists on every machine this runs on.
 */
export const FALLBACK_SHELL = '/bin/sh';

/**
 * Never this binary: `memnox run` overwrites `SHELL`,
 * so reading it back would exec the wrapper for ever.
 */
export function realShell(env: NodeJS.ProcessEnv, self: string): string {
  for (const candidate of [env[REAL_SHELL_VAR], env['SHELL']]) {
    if (isOtherShell(candidate, self)) return candidate;
  }
  return FALLBACK_SHELL;
}

function isOtherShell(candidate: string | undefined, self: string): candidate is string {
  return (
    candidate !== undefined && candidate !== '' && basename(candidate) !== basename(self)
  );
}
