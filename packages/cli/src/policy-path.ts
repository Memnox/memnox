import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPolicySet, readPolicyRegistry, type PolicySet } from '@memnox/core';
import type { CliContext } from './cli-context';
import { policyRegistryPath } from './policy-registry';

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

/**
 * Every rule file actually in force here: the registry names each repository on the
 * disk, and the file in this directory joins it whether or not it was ever registered.
 *
 * Shared rather than repeated, because `check` read the registry and `explain` read one
 * file, so the same machine answered "nothing here would stop it" to one command and
 * named a rule to the other.
 */
export async function policyFilesInForce(
  homeDir: string,
  explicit?: string,
  exists: (path: string) => boolean = existsSync,
): Promise<string[]> {
  const here = resolvePolicyFile(explicit, exists);
  // An explicit --file is the whole question: nothing else is loaded behind it.
  if (explicit !== undefined) return [here];

  const files = new Set(await readPolicyRegistry(policyRegistryPath(homeDir)));
  if (exists(here)) files.add(resolve(here));
  return [...files];
}

/**
 * The rules in force, loaded file by file so one stale file never blanks the rest.
 *
 * `LocalGate.fromFiles` throws on the first bad document, which is right for a single
 * named file and wrong for the whole machine: one repository with an old effect
 * spelling took `explain` and `policy test` down with it and answered a question about
 * this directory by refusing.
 */
export async function policySetInForce(
  homeDir: string,
  explicit?: string,
): Promise<PolicySet> {
  return loadPolicySet(await policyFilesInForce(homeDir, explicit));
}

/** What did not load, said out loud: a missing rule must never be a silent one. */
export function sayWhatDidNotLoad(context: CliContext, set: PolicySet): void {
  for (const broken of set.unreadable) {
    const count = broken.issues.length;
    context.out.note(
      `${broken.file} would not load — ${count} problem${count === 1 ? '' : 's'}, so its rules are not in force.`,
    );
    context.out.note(`  fix them with "memnox policy check --fix ${broken.file}"`);
  }
}
