import { homedir } from 'node:os';
import {
  POLICY_FILE_EXTENSION,
  readPolicyDocumentFile,
  writePolicyDocumentFile,
  type Policy,
} from '@memnox/core';
import { registerPolicyFile } from '../policy-registry';

/** Rules written into the policy file, replacing only the ones the writer owns by name. */

/** The file every `protect` writer adds its rules to, relative to where it runs. */
export const WRITTEN_POLICY_FILE = `memnox.policies${POLICY_FILE_EXTENSION}`;

/**
 * Merged by name, so a second `protect --for` never deletes the first set and a re-run
 * updates rather than duplicates.
 */
export async function mergeRules(
  path: string,
  rules: readonly Policy[],
  home: string = homedir(),
): Promise<void> {
  const document = await readPolicyDocumentFile(path);
  const existing = document?.policies ?? [];
  const replacing = new Set(rules.map((rule) => rule.name));

  await writePolicyDocumentFile(path, {
    ...(document ?? { version: 1 }),
    policies: [...existing.filter((rule) => !replacing.has(rule.name)), ...rules],
  });
  await registerPolicyFile(home, path);
}
