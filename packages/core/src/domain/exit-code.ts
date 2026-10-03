import { constants } from 'node:os';

/**
 * Every exit code this product produces, and what each one means to whoever reads it.
 * A seam's exit code is the only thing an agent reliably sees, so these are contract.
 */
export const EXIT = {
  /** The command ran and the seam had nothing to say about it. */
  OK: 0,

  /** The command was asked for and could not be completed. The ordinary failure. */
  FAILED: 1,

  /** The command was called wrongly: a missing argument, or a flag that needs a value. */
  MISUSED: 2,

  /**
   * A rule refused this, so the command never ran. Distinct from `FAILED` so an agent does
   * not retry a refusal as a fault; 77 is the conventional `EX_NOPERM`.
   */
  WITHHELD: 77,

  /** The command was found and could not be executed, which is what a shell reports for EACCES. */
  NOT_EXECUTABLE: 126,

  /** A shell could not find the command at all. What `exec` reports for a missing binary. */
  NOT_FOUND: 127,

  /**
   * Added to a signal number for a process a signal ended, which is what a shell reports:
   * SIGTERM is 15, so a terminated child exits 143.
   */
  SIGNALLED_BASE: 128,
} as const;

/** Spawn error codes a shell reports as its own exit code rather than as a failure. */
const SPAWN_ERROR_EXIT: Readonly<Record<string, number>> = {
  ENOENT: EXIT.NOT_FOUND,
  EACCES: EXIT.NOT_EXECUTABLE,
};

/** What a process ended by this signal exits with, as a shell would report it. */
export function exitCodeForSignal(signal: NodeJS.Signals): number {
  // Looked up by name because a signal missing on this platform has no number to add.
  const number: number | undefined = constants.signals[signal];
  return number === undefined ? EXIT.FAILED : EXIT.SIGNALLED_BASE + number;
}

/**
 * What a child that exited reports, as a shell would: its own code, or 128 plus the
 * signal that ended it, so a killed command never reads as a refusal.
 */
export function exitCodeForChild(
  code: number | null,
  signal: NodeJS.Signals | null,
): number {
  if (code !== null) return code;
  return signal === null ? EXIT.FAILED : exitCodeForSignal(signal);
}

/** What a child that could not be started reports: 127 when missing, 126 when not executable. */
export function exitCodeForSpawnError(err: unknown): number {
  const code =
    typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
  return typeof code === 'string' ? (SPAWN_ERROR_EXIT[code] ?? EXIT.FAILED) : EXIT.FAILED;
}
