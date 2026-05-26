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
  return validatePolicyDocument(parse(raw)).policies;
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
