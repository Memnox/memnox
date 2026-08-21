import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { stringify } from 'yaml';
import {
  findPolicyPack,
  POLICY_DOCUMENT_VERSION,
  type Policy,
} from '@memnox/policy-engine';
import type { CliOutput } from './cli-output';
import { STARTER_POLICY_FILE } from './defaults';
import { resolveProjectId } from './project-identity';

/** What `setup` and `quickstart` share; they differ only in starting the runtime. */

/** Never overwrites: rules someone authored outrank anything we would scaffold. */
interface PolicyFileOptions {
  project?: string;
  /** A ready-made document, e.g. one composed from detected packs. */
  content?: string;
}

export async function ensurePolicyFile(
  file: string,
  out: CliOutput,
  options: PolicyFileOptions = {},
): Promise<boolean> {
  const { project, content } = options;
  if (existsSync(file)) {
    out.note(`Keeping the policy file already at ${file}`);
    if (project !== undefined) reportProjectMismatch(file, project, out);
    return false;
  }

  const declaration = project === undefined ? '' : `project: ${project}\n`;
  await writeFile(file, content ?? `${declaration}${STARTER_POLICY_FILE}`, 'utf8');
  out.line(
    project === undefined
      ? `Wrote starter policies to ${file}`
      : `Wrote starter policies to ${file} (project: ${project})`,
  );
  return true;
}

/** Duplicate names collapse to the first — two packs guarding one thing is redundancy. */
export function composePolicyDocument(
  project: string | undefined,
  packNames: readonly string[],
): string {
  const policies: Policy[] = [];
  const seen = new Set<string>();
  for (const name of packNames) {
    const pack = findPolicyPack(name);
    if (pack === null) continue;
    for (const policy of pack.policies) {
      if (seen.has(policy.name)) continue;
      seen.add(policy.name);
      policies.push(policy);
    }
  }
  return stringify(
    project === undefined
      ? { version: POLICY_DOCUMENT_VERSION, policies }
      : { project, version: POLICY_DOCUMENT_VERSION, policies },
  );
}

/** A silently ignored --project would split one project into two scopes without saying so. */
function reportProjectMismatch(file: string, project: string, out: CliOutput): void {
  const absolute = resolve(file);
  const declared = resolveProjectId(dirname(absolute), basename(absolute));
  if (declared === project) return;

  out.note(
    declared === undefined
      ? `It declares no project — add "project: ${project}" to it to join that scope.`
      : `It declares project "${declared}", not "${project}" — left unchanged.`,
  );
}
