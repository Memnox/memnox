import type { Command } from 'commander';

/** What to say about a word that is not a command, including the ones that moved. */

/** How far apart two words may be before a suggestion is noise rather than help. */
const MAX_SUGGESTION_DISTANCE = 3;

/**
 * Commands that moved, and what answers their question now, because a nearest-word guess
 * sends `diff` to `deny`, which is a different command that runs.
 */
const MOVED: Readonly<Record<string, string>> = {
  diff: 'memnox scan --since <when>',
  autopilot: 'memnox next --agent <name>',
  verify: 'memnox doctor --prove',
  spend:
    'nothing here: this machine cannot price a model call, so it no longer pretends to',
};

/** Named here because commander hands an unknown word to `scan`, the default, as an argument. */
export function describeUnknownCommand(program: Command, word: string): string {
  const moved = MOVED[word.toLowerCase()];
  if (moved !== undefined) {
    return `"${word}" is gone. It is now:  ${moved}`;
  }
  const names = program.commands.map((command) => command.name());
  const nearest = names
    .map((name) => ({ name, distance: editDistance(word, name) }))
    .filter((each) => each.distance <= MAX_SUGGESTION_DISTANCE)
    .sort((a, b) => a.distance - b.distance)[0];
  return (
    `unknown command "${word}"` +
    (nearest === undefined ? '' : `, did you mean "${nearest.name}"?`) +
    '\nRun "memnox help --all" for the full list.'
  );
}

/** Levenshtein, iterative: a typo is one or two edits away from what was meant. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      // Every index read here was written on this row or the one before it.
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        substitution,
      );
    }
    previous = current;
  }
  return previous[b.length] as number;
}
