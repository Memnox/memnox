import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { DEFAULT_POLICY_FILE } from './defaults';

/**
 * Resolves which governance unit a working directory belongs to.
 *
 * The repository is deliberately not the unit. A frontend and a backend repo
 * that both declare `project: acme-checkout` share one policy and memory scope,
 * so the identifier is read from the policy file rather than inferred from the
 * directory — declared, committed, and reviewable in a diff.
 */

/** A repo nested deeply under $HOME still terminates; nothing legitimate is deeper. */
const MAX_PARENT_WALK = 40;
const PROJECT_KEY = 'project';

export function findPolicyFile(
  startDir: string,
  fileName: string = DEFAULT_POLICY_FILE,
): string | undefined {
  let current = resolve(startDir);
  for (let depth = 0; depth < MAX_PARENT_WALK; depth += 1) {
    const candidate = join(current, fileName);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined; // Filesystem root.
    current = parent;
  }
  return undefined;
}

/**
 * The declared project for a working directory, or undefined when there is no
 * policy file or it declares none. Never throws: an unreadable or malformed
 * file means "no project", never a broken tool call.
 */
export function resolveProjectId(
  cwd: string | undefined,
  fileName: string = DEFAULT_POLICY_FILE,
): string | undefined {
  if (cwd === undefined || cwd.length === 0) return undefined;

  const file = findPolicyFile(cwd, fileName);
  if (file === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined; // Malformed YAML is the validator's error to report, not the hook's.
  }

  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const project = (parsed as Record<string, unknown>)[PROJECT_KEY];
  if (typeof project !== 'string' || project.trim().length === 0) return undefined;
  return project.trim();
}
