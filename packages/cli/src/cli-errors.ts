/** The single failure path: every command reads this machine, so the cause is local. */
export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
