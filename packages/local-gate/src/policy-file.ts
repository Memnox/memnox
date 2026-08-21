import { readFile, rename, writeFile } from 'node:fs/promises';
import { parse, stringify } from 'yaml';
import type { Policy, PolicyDocument } from '@memnox/policy-engine';
import { POLICY_DOCUMENT_VERSION, validatePolicyDocument } from '@memnox/policy-engine';

/** Reads and validates a YAML policy file. Throws PolicyValidationError with every issue. */
export async function loadPoliciesFromFile(filePath: string): Promise<Policy[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    // A bare ENOENT in a crash loop tells an operator nothing actionable.
    if (isMissingFile(err)) {
      throw new Error(
        `No policy file at ${filePath} — create one with "memnox init --file ${filePath}", ` +
          'or start without --policies to run on advisors alone.',
      );
    }
    throw err;
  }
  const document = validatePolicyDocument(parse(raw));
  if (document.project === undefined) return document.policies;
  // Rules inherit their file's project so the engine can keep one repo's rules
  // from deciding another project's actions.
  return document.policies.map((policy) => ({ ...policy, project: document.project }));
}

/** One file per repository; they compose under most-restrictive-wins. */
export async function loadPolicyFiles(filePaths: readonly string[]): Promise<Policy[]> {
  const policies: Policy[] = [];
  for (const filePath of filePaths) {
    policies.push(...(await loadPoliciesFromFile(filePath)));
  }
  return policies;
}

interface PolicyRegistry {
  files?: string[];
}

/** Paths only — rule content never travels, so a rule stays in its own repo's diff. */
export async function readPolicyRegistry(filePath: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    // No registry yet is the normal single-repository case, not an error.
    if (isMissingFile(err)) return [];
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) return [];
  const files = (parsed as PolicyRegistry).files;
  return Array.isArray(files) ? files.filter((file) => typeof file === 'string') : [];
}

function isMissingFile(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

/** The whole document: an editor needs `project` as declared, not folded into each rule. */
export async function readPolicyDocumentFile(
  filePath: string,
): Promise<PolicyDocument | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    // Nothing written yet: the caller starts from an empty rule set.
    if (isMissingFile(err)) return null;
    throw err;
  }
  return validatePolicyDocument(parse(raw));
}

/** Temp file and rename, so a crash mid-write cannot truncate the rule set. */
export async function writePolicyDocumentFile(
  filePath: string,
  document: PolicyDocument,
): Promise<void> {
  const serialized = stringify({
    version: POLICY_DOCUMENT_VERSION,
    ...(document.project === undefined ? {} : { project: document.project }),
    policies: document.policies,
  });
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, serialized, 'utf8');
  await rename(temporary, filePath);
}

export async function writePoliciesToFile(
  filePath: string,
  policies: readonly Policy[],
): Promise<void> {
  await writePolicyDocumentFile(filePath, {
    version: POLICY_DOCUMENT_VERSION,
    policies: [...policies],
  });
}
