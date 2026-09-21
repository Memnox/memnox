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

  /** A shell could not find the command at all. What `exec` reports for a missing binary. */
  NOT_FOUND: 127,

  /**
   * Added to a signal number for a process a signal ended, which is what a shell reports:
   * SIGTERM is 15, so a terminated child exits 143.
   */
  SIGNALLED_BASE: 128,
} as const;

/** Signal numbers for the signals a client ends its servers with. */
export const SIGNAL_NUMBER = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15,
} as const;

/** What a process ended by this signal exits with, as a shell would report it. */
export function exitCodeForSignal(signal: keyof typeof SIGNAL_NUMBER): number {
  return EXIT.SIGNALLED_BASE + SIGNAL_NUMBER[signal];
}
