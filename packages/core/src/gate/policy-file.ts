import { readFile, rename, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { parse, stringify } from 'yaml';
import type { Policy, PolicyDocument } from '../policy/index';
import {
  POLICY_DOCUMENT_VERSION,
  PolicyValidationError,
  validatePolicyDocument,
} from '../policy/index';

/**
 * TOML is the format the build plan specifies and what new files are written in. YAML
 * is still read, because a rule file somebody already has must not stop working on an
 * upgrade — the shape both produce is identical, so only the parser differs.
 */
export function parsePolicySource(raw: string, filePath: string): unknown {
  return extname(filePath).toLowerCase() === '.toml' ? parseToml(raw) : parse(raw);
}

/** The extension a new policy file gets. */
export const POLICY_FILE_EXTENSION = '.toml';

/** Reads and validates a policy file. Throws PolicyValidationError with every issue. */
export async function loadPoliciesFromFile(filePath: string): Promise<Policy[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    // A bare ENOENT in a crash loop tells an operator nothing actionable.
    if (isMissingFile(err)) {
      throw new Error(
        `No policy file at ${filePath}. Write one with "memnox protect --apply".`,
      );
    }
    throw err;
  }
  const document = named(filePath, () =>
    validatePolicyDocument(parsePolicySource(raw, filePath)),
  );
  if (document.project === undefined) return document.policies;
  // Rules inherit their file's project so the engine can keep one repo's rules
  // from deciding another project's actions.
  return document.policies.map((policy) => ({ ...policy, project: document.project }));
}

/** Re-raises a validation failure carrying the file it came from. */
function named<T>(filePath: string, read: () => T): T {
  try {
    return read();
  } catch (err) {
    if (err instanceof PolicyValidationError) {
      throw new PolicyValidationError(err.issues, filePath);
    }
    throw err;
  }
}

/** A path whose absence is tolerable, and how to say so when it is skipped. */
export interface OptionalPolicySources {
  /** Paths registered by *other* repositories on this machine. */
  optional: ReadonlySet<string>;
  /** Told which registered file vanished, so a skip is never silent. */
  onSkipped?: (filePath: string) => void;
}

/** One file per repository; they compose under most-restrictive-wins. */
export async function loadPolicyFiles(
  filePaths: readonly string[],
  sources?: OptionalPolicySources,
): Promise<Policy[]> {
  const policies: Policy[] = [];
  for (const filePath of filePaths) {
    // A path this run named itself must exist — a typo has to be loud. A path
    // another repo registered belongs to a checkout that may since have been
    // deleted or moved, and one dead entry must not stop every other project
    // on the machine from starting.
    if (sources !== undefined && sources.optional.has(filePath)) {
      const loaded = await loadOptionalPolicyFile(filePath);
      if (loaded === null) {
        if (sources.onSkipped !== undefined) sources.onSkipped(filePath);
        continue;
      }
      policies.push(...loaded);
      continue;
    }
    policies.push(...(await loadPoliciesFromFile(filePath)));
  }
  return policies;
}

/**
 * Null when the file is gone; a malformed one still throws — that is a real fault, and
 * skipping it would start the runtime with a repository's rules silently not in force,
 * which is worse than not starting. It throws naming the file, so the fix is findable.
 */
async function loadOptionalPolicyFile(filePath: string): Promise<Policy[] | null> {
  try {
    return await loadPoliciesFromFile(filePath);
  } catch (err) {
    if (isMissingPolicyFile(err)) return null;
    throw err;
  }
}

/** `loadPoliciesFromFile` rewrites ENOENT into guidance, so match on the path it names. */
function isMissingPolicyFile(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('No policy file at ');
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
  return validatePolicyDocument(parsePolicySource(raw, filePath));
}

/** Temp file and rename, so a crash mid-write cannot truncate the rule set. */
export async function writePolicyDocumentFile(
  filePath: string,
  document: PolicyDocument,
): Promise<void> {
  const shape = {
    version: POLICY_DOCUMENT_VERSION,
    ...(document.project === undefined ? {} : { project: document.project }),
    policies: document.policies,
  };
  // Written in the format the file already is, so a save never changes somebody's format.
  const serialized =
    extname(filePath).toLowerCase() === POLICY_FILE_EXTENSION
      ? stringifyToml(shape)
      : stringify(shape);
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
