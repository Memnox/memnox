/** A count with its noun, so "1 agent" and "3 agents" are spelled in one place. */

export function describeCount(count: number, noun: string, plural = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural}`;
}
