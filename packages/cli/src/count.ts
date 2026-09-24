/** A number and its noun, singular for one and plural otherwise, in one place. */

/** `count(3, 'agent')` is "3 agents"; pass `plural` for a noun that does not take an s. */
export function count(amount: number, noun: string, plural = `${noun}s`): string {
  return `${amount} ${amount === 1 ? noun : plural}`;
}
