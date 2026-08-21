/** A store never written is a first run; every other read error must reach the caller. */
export function isFileMissing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { code?: unknown }).code === 'ENOENT';
}
