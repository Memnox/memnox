import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPolicySet, readPolicyRegistry, type PolicySet } from '@memnox/core';
import type { CliContext } from './cli-context';
import { TONE } from './flow';
import { describeCount } from './plural';
import { policyRegistryPath } from './policy-registry';

/** Where the rules in force are found: the file here, and every file the registry names. */

/** TOML is what new files are written as; a YAML file somebody already has still counts. */
export const POLICY_FILES = ['memnox.policies.toml', 'memnox.policies.yaml'] as const;

/**
 * The rule file actually on disk, whichever format it is in, because defaulting to one
 * extension reports rules `protect` wrote as absent.
 */
export function resolvePolicyFile(
  explicit?: string,
  exists: (path: string) => boolean = existsSync,
): string {
  if (explicit !== undefined) return explicit;
  return POLICY_FILES.find((candidate) => exists(candidate)) ?? POLICY_FILES[0];
}

/**
 * Every rule file in force: the registry names each repository on the disk, and the file
 * in this directory joins it whether or not it was registered. Shared so two commands
 * never answer differently about one machine.
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
 * The rules in force, loaded file by file so one stale file never blanks the rest, where
 * `LocalGate.fromFiles` would throw on the first bad document.
 */
export async function policySetInForce(
  homeDir: string,
  explicit?: string,
): Promise<PolicySet> {
  return loadPolicySet(await policyFilesInForce(homeDir, explicit));
}

/** The files the registry names, or none when it is unreadable, for readers that only report. */
export async function readRegisteredFiles(homeDir: string): Promise<string[]> {
  try {
    return await readPolicyRegistry(policyRegistryPath(homeDir));
  } catch {
    // No registry yet is the ordinary first run, and no rules is the true answer.
    return [];
  }
}

/** What did not load, said out loud on the caller's own rail: a missing rule must never be silent. */
export function renderWhatDidNotLoad(
  context: CliContext,
  set: Pick<PolicySet, 'unreadable'>,
): void {
  if (set.unreadable.length === 0) return;
  context.flow.list(
    'Not in force',
    set.unreadable.map((broken) => ({
      tone: TONE.WARN,
      text: `${broken.file} would not load, so its rules are not in force`,
      detail: [
        describeCount(broken.issues.length, 'problem'),
        `see them with "memnox policy check ${broken.file}"`,
      ],
    })),
  );
}
