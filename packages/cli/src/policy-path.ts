import { existsSync } from 'node:fs';

/** TOML is what new files are written as; a YAML file somebody already has still counts. */
export const POLICY_FILES = ['memnox.policies.toml', 'memnox.policies.yaml'] as const;

/**
 * The rule file actually on disk, whichever format it is in. Defaulting to one
 * extension meant `protect` wrote rules that `explain` and `policy test` then reported
 * as absent — the worst kind of wrong answer, because it reads as "you are not
 * governed" about a machine that is.
 */
export function resolvePolicyFile(
  explicit?: string,
  exists: (path: string) => boolean = existsSync,
): string {
  if (explicit !== undefined) return explicit;
  return POLICY_FILES.find((candidate) => exists(candidate)) ?? POLICY_FILES[0];
}
