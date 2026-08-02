/**
 * A store that was never written is a first run, not a failure. Every other
 * read error is real and must reach the caller — a corrupt file silently
 * reading as "empty" is how a runtime loses state without anyone noticing.
 */
export function isFileMissing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { code?: unknown }).code === 'ENOENT';
}
