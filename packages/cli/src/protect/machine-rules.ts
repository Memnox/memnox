import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  MEMNOX_HOME,
  POLICY_DOMAIN,
  POLICY_FILE_EXTENSION,
  policiesFrom,
  readPolicyDocumentFile,
  recommendedAnswers,
  writePolicyDocumentFile,
  type Policy,
  type PolicyDomain,
} from '@memnox/core';
import { mergeRules } from './merge-rules';

/**
 * The rules that are about this machine rather than a repository, in a file under
 * `~/.memnox` the registry names. A key in `~/.ssh` is the same key from every checkout,
 * so its rule must not live in one that can be deleted, moved, or edited by the agent.
 */

/** The machine's own rule file, beside the registry that names it. */
const MACHINE_POLICY_FILE = `machine.policies${POLICY_FILE_EXTENSION}`;

/** Owner only, as every other directory under `~/.memnox` is made. */
const HOME_MODE = 0o700;

/** The domains whose baseline rule is the machine's, not the repository's. */
const MACHINE_DOMAINS: readonly PolicyDomain[] = [POLICY_DOMAIN.FILESYSTEM];

export function machinePolicyPath(home: string): string {
  return join(home, MEMNOX_HOME, MACHINE_POLICY_FILE);
}

/** The recommended baseline, split into the machine's rules and the repository's. */
export function baselineRules(): { machine: Policy[]; project: Policy[] } {
  const machine: Policy[] = [];
  const project: Policy[] = [];
  for (const [domain, effect] of recommendedAnswers()) {
    const rules = policiesFrom(new Map([[domain, effect]]));
    (MACHINE_DOMAINS.includes(domain) ? machine : project).push(...rules);
  }
  return { machine, project };
}

/** Merged by name and registered, so a rerun updates rather than duplicates. */
export async function writeMachineRules(
  home: string,
  rules: readonly Policy[],
): Promise<void> {
  const path = machinePolicyPath(home);
  await mkdir(dirname(path), { recursive: true, mode: HOME_MODE });
  await mergeRules(path, rules, home);
}

/**
 * Takes a machine rule out of a repository's file where an earlier setup put it there
 * and nobody has changed it since, so the rule is counted and enforced once. A rule
 * somebody edited is theirs, and stays. True when the file was rewritten.
 */
export async function moveOutOfProject(
  path: string,
  rules: readonly Policy[],
): Promise<boolean> {
  const document = await readPolicyDocumentFile(path);
  if (document === null) return false;
  const kept = document.policies.filter(
    (policy) => !rules.some((rule) => isSameRule(policy, rule)),
  );
  if (kept.length === document.policies.length) return false;
  await writePolicyDocumentFile(path, { ...document, policies: kept });
  return true;
}

/** The rule setup wrote: same name, same effect, same actions, same targets. */
function isSameRule(found: Policy, written: Policy): boolean {
  return (
    found.name === written.name &&
    found.decision.effect === written.decision.effect &&
    sameList(found.match.actions, written.match.actions) &&
    sameList(found.match.targets, written.match.targets)
  );
}

function sameList(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}
