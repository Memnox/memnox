import { readFile, rename, writeFile } from 'node:fs/promises';
import { parse, stringify } from 'yaml';
import type { Policy } from '@memnox/policy-engine';
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

/**
 * Loads every configured rule source into one set. A project spanning several
 * repositories contributes one file per repository; they compose here, and the
 * engine's most-restrictive-wins does the rest.
 */
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

/**
 * The registry is how a second repository's rules reach a runtime that is
 * already running: `memnox setup` appends the path, then asks for a reload.
 * Paths only — rule content never travels over the API, so every rule stays
 * reviewable in the diff of the repository that owns it.
 */
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

/**
 * Writes via a temp file and rename so a crash mid-write cannot leave the
 * runtime with a truncated rule set on its next start.
 */
export async function writePoliciesToFile(
  filePath: string,
  policies: readonly Policy[],
): Promise<void> {
  const document = stringify({
    version: POLICY_DOCUMENT_VERSION,
    policies,
  });
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, document, 'utf8');
  await rename(temporary, filePath);
}
