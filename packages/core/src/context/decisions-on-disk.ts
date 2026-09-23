/**
 * The rules and decisions that apply to one repository, read from the files this machine
 * registered: the team's bundle, the machine's own rules, and the repository's file. A rule
 * file belonging to another repository is left out, since its rules never decide here.
 */
import { join } from 'node:path';

import { MEMNOX_HOME } from '../config/config';
import { isInside } from '../gate/containment';
import { loadPoliciesFromFile } from '../gate/policy-file';
import { orgPolicyPathFor } from '../policy/org-bundle';
import { matchesAny } from '../policy/pattern-matcher';
import type { Policy } from '../policy/policy';
import { readJsonFile } from '../store/json-records';
import {
  DECISION_ORIGIN,
  decisionsOf,
  type DecidedLocally,
  type DecisionOrigin,
  type RememberedDecision,
} from './remembered';

/** Written by `memnox protect` on an enrolled machine, and read here for the dates. */
export const DECIDED_RULES_FILE = 'decided-rules.json';

export interface DecisionSources {
  home: string;
  /** Every rule file this machine registered, as the gate reads them. */
  policyFiles: readonly string[];
  /** The repository the session works in, where it is in one. */
  root?: string;
  /** Rules narrowed to other agents are left out. */
  agent: string;
}

export interface RulesHere {
  rules: Policy[];
  decisions: RememberedDecision[];
}

/** A file that will not load is skipped, as the gate skips it, rather than failing a session. */
export async function rulesHere(sources: DecisionSources): Promise<RulesHere> {
  const decided = await decidedLocallyOn(sources.home);
  const rules: Policy[] = [];
  const decisions: RememberedDecision[] = [];
  for (const file of sources.policyFiles) {
    const origin = originOf(file, sources);
    if (origin === null) continue;
    const loaded = await loadPoliciesFromFile(file).catch((): Policy[] => []);
    const mine = loaded.filter((rule) => matchesAny(rule.match.agents, sources.agent));
    rules.push(...mine);
    decisions.push(
      ...decisionsOf(mine, origin, origin === DECISION_ORIGIN.MACHINE ? decided : []),
    );
  }
  return { rules, decisions };
}

/** What a person decided on this machine, with when. Empty where nothing was kept. */
export async function decidedLocallyOn(home: string): Promise<DecidedLocally[]> {
  const held = await readJsonFile<{ decisions?: unknown }>(
    join(home, MEMNOX_HOME, DECIDED_RULES_FILE),
  );
  if (held === null || !Array.isArray(held.decisions)) return [];
  // Written by `memnox protect` alone, so an entry here is its shape; each field is checked.
  return (held.decisions as Partial<DecidedLocally>[]).filter(
    (each): each is DecidedLocally =>
      typeof each.operation === 'string' &&
      typeof each.effect === 'string' &&
      typeof each.decidedAt === 'string',
  );
}

function originOf(file: string, sources: DecisionSources): DecisionOrigin | null {
  if (file === orgPolicyPathFor(sources.home)) return DECISION_ORIGIN.TEAM;
  if (isInside(join(sources.home, MEMNOX_HOME), file)) return DECISION_ORIGIN.MACHINE;
  if (sources.root !== undefined && isInside(sources.root, file))
    return DECISION_ORIGIN.REPOSITORY;
  return null;
}
