import { homedir } from 'node:os';
import {
  readPolicyDocumentFile,
  writePolicyDocumentFile,
  type Policy,
} from '@memnox/core';
import { registerPolicyFile } from '../policy-registry';

/**
 * Rules added to whatever the file already holds, replacing only the ones the
 * caller owns by name.
 *
 * Every writer here used to build the document from its own rules alone, so
 * writing a second set silently deleted the first while reporting success:
 * `protect --for gh` then `protect --for git` left a file with git in it and
 * nothing about gh, and nobody was told. Re-running for the same thing has to
 * update rather than duplicate, which is what matching on name gives.
 *
 * One function rather than one per writer, because three of them had the same
 * bug and the fourth would have had it too.
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
