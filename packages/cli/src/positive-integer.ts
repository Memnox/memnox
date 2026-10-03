/** Every flag that takes a count is read here, so `abc`, `0` and `-1` fail the same way. */

const WHOLE_NUMBER = /^\d+$/;

export function positiveInteger(raw: string, flag: string): number {
  const trimmed = raw.trim();
  const value = WHOLE_NUMBER.test(trimmed) ? Number(trimmed) : Number.NaN;
  // Checked after the pattern too, because a run of zeros matches it and is still zero.
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${flag} takes a whole number above zero. Got "${raw}".`);
  }
  return value;
}
