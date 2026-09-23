import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { parse, stringify } from 'yaml';
import type { Policy, PolicyDocument } from '../policy/index';
import {
  POLICY_DOCUMENT_VERSION,
  PolicyValidationError,
  validatePolicyDocument,
} from '../policy/index';
import { writeAtomic } from '../store/atomic-file';

/**
 * Reading and writing rule files. New files are TOML, and YAML is still read so a file
 * somebody already has keeps working; both parse to the same shape.
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
  const document = withFileNamed(filePath, () =>
    validatePolicyDocument(parsePolicySource(raw, filePath)),
  );
  if (document.project === undefined) return document.policies;
  // Rules inherit their file's project so the engine can keep one repo's rules
  // from deciding another project's actions.
  return document.policies.map((policy) => ({ ...policy, project: document.project }));
}

/** Re-raises a validation failure carrying the file it came from. */
function withFileNamed<T>(filePath: string, read: () => T): T {
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
    // A path this run named must exist so a typo is loud, but one another repository
    // registered may be a deleted checkout, which must not stop every other project.
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
 * Null when the file is gone. A malformed one still throws, naming the file, because
 * starting with a repository's rules silently not in force is worse than not starting.
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

/** Paths only, because rule content never travels, so a rule stays in its own repo's diff. */
export async function readPolicyRegistry(filePath: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    // No registry yet is the normal single-repository case, not an error.
    if (isMissingFile(err)) return [];
    throw err;
  }
  // Unguarded on purpose: reading a corrupt registry as empty would let the next
  // registration overwrite it and silently drop every other repository's rules.
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
  await writeAtomic(filePath, serialized);
}

/** One file that is there, will not load, and everything wrong with it. */
export interface UnreadablePolicyFile {
  file: string;
  issues: string[];
}

/** A file that loaded, and how many of the rules in force came from it. */
export interface LoadedPolicyFile {
  file: string;
  rules: number;
}

export interface PolicySet {
  /** The rules actually in force, from the files that loaded. */
  policies: Policy[];
  loaded: LoadedPolicyFile[];
  unreadable: UnreadablePolicyFile[];
  /** Registered by a checkout that has since moved or been deleted. */
  missing: string[];
}

/**
 * Every registered file, loaded one at a time so one stale file cannot blank the rest.
 * The gate keeps `loadPolicyFiles`, which throws, because there the answer decides a call.
 */
export async function loadPolicySet(filePaths: readonly string[]): Promise<PolicySet> {
  const set: PolicySet = { policies: [], loaded: [], unreadable: [], missing: [] };
  for (const filePath of filePaths) {
    try {
      const policies = await loadPoliciesFromFile(filePath);
      set.policies.push(...policies);
      set.loaded.push({ file: filePath, rules: policies.length });
    } catch (err) {
      if (isMissingPolicyFile(err)) {
        set.missing.push(filePath);
        continue;
      }
      set.unreadable.push({
        file: filePath,
        issues:
          err instanceof PolicyValidationError
            ? err.issues
            : [err instanceof Error ? err.message : String(err)],
      });
    }
  }
  return set;
}
