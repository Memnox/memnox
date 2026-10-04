/**
 * pnpm, yarn and bun push to the registry npm pushes to, so a rule naming `npm.publish`
 * has to cover the publish whichever of them ran it. Only the publishing verbs: an
 * install is each client's own and belongs with the package-manager classifier.
 */

/** The publishing verbs all four clients spell the way npm does. */
const PUBLISH_VERBS: readonly string[] = ['publish', 'unpublish', 'dist-tag'];

const WORKALIKES: readonly string[] = ['pnpm', 'yarn', 'bun'];

interface NpmPublish {
  /** The command as npm's own table reads it. */
  words: readonly string[];
  /** The client that actually ran it, so a row names what a person typed. */
  because: string;
}

/** Null when this is not one of npm's workalikes publishing. */
export function npmPublishIn(binary: string, args: readonly string[]): NpmPublish | null {
  if (!WORKALIKES.includes(binary)) return null;
  // `yarn npm publish` is yarn's own spelling of the same command.
  const words = binary === 'yarn' && args[0] === 'npm' ? args.slice(1) : args;
  if (!PUBLISH_VERBS.includes(words[0] ?? '')) return null;
  return { words, because: `${binary} ${words.join(' ')}`.trim() };
}
