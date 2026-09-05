import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parse } from 'yaml';
import { POLICY_FILES } from './policy-path';

/** The repository is deliberately not the unit — a frontend and backend can share one. */

/** A repo nested deeply under $HOME still terminates; nothing legitimate is deeper. */
const MAX_PARENT_WALK = 40;
const PROJECT_KEY = 'project';

/**
 * Both formats are tried at every level rather than one name resolved from the current
 * directory: the file being looked for is in the directory being walked, which is not
 * where the process happens to be running.
 */
export function findPolicyFile(
  startDir: string,
  fileNames: readonly string[] = POLICY_FILES,
): string | undefined {
  let current = resolve(startDir);
  for (let depth = 0; depth < MAX_PARENT_WALK; depth += 1) {
    for (const fileName of fileNames) {
      const candidate = join(current, fileName);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(current);
    if (parent === current) return undefined; // Filesystem root.
    current = parent;
  }
  return undefined;
}

/** Never throws: a malformed file is the validator's error to report, not this. */
export function resolveProjectId(
  cwd: string | undefined,
  fileNames: readonly string[] = POLICY_FILES,
): string | undefined {
  if (cwd === undefined || cwd.length === 0) return undefined;

  const file = findPolicyFile(cwd, fileNames);
  if (file === undefined) return undefined;

  let parsed: unknown;
  try {
    const raw = readFileSync(file, 'utf8');
    parsed = extname(file) === '.toml' ? parseToml(raw) : parse(raw);
  } catch {
    // Malformed input is the validator's error to report, not this walk's.
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const project = (parsed as Record<string, unknown>)[PROJECT_KEY];
  if (typeof project !== 'string' || project.trim().length === 0) return undefined;
  return project.trim();
}
