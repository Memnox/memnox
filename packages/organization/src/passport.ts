import type { AgentRole, Subject } from './subject';

/**
 * A view, not a table. Assembled from every phase, which is why it is the one screen
 * that answers "what is this agent" without anybody typing anything.
 */
export interface Passport {
  /** §00 discovery and §04 enrolment. */
  subject: Subject;
  role?: AgentRole;
  surfaces: string[];
  reachability: string[];
  /** §02: what is watched, and what each seam cannot see. */
  seams: Array<{ kind: string; mode: string; blindTo: string[] }>;
  capabilities: string[];
  /** §03: what it used, what it never needed, and who caused what. */
  usage: Array<{ action: string; count: number }>;
  unusedGrants: string[];
  lineage: string[];
  /** §05 and §06. */
  policies: string[];
  delegatedBy: string[];
  /** §07. */
  owner?: string;
  /** §09 and §10. */
  spendCents?: number;
  autonomyLevel?: number;
  readiness?: Array<{ key: string; status: string }>;
}

export interface PassportSources {
  subject: Subject;
  role?: AgentRole;
  surfaces?: string[];
  reachability?: string[];
  seams?: Array<{ kind: string; mode: string; blindTo: string[] }>;
  capabilities?: string[];
  usage?: Array<{ action: string; count: number }>;
  unusedGrants?: string[];
  lineage?: string[];
  policies?: string[];
  delegatedBy?: string[];
  owner?: string;
  spendCents?: number;
  autonomyLevel?: number;
  readiness?: Array<{ key: string; status: string }>;
}

/**
 * Every field is read from the phase that owns it. A blank one is a phase that has not
 * shipped or a store with nothing in it, and either way the passport says so by being
 * empty rather than by inventing a value.
 */
export function assemblePassport(sources: PassportSources): Passport {
  return {
    subject: sources.subject,
    ...(sources.role === undefined ? {} : { role: sources.role }),
    surfaces: sources.surfaces ?? [],
    reachability: sources.reachability ?? [],
    seams: sources.seams ?? [],
    capabilities: sources.capabilities ?? [],
    usage: sources.usage ?? [],
    unusedGrants: sources.unusedGrants ?? [],
    lineage: sources.lineage ?? [],
    policies: sources.policies ?? [],
    delegatedBy: sources.delegatedBy ?? [],
    ...(sources.owner === undefined ? {} : { owner: sources.owner }),
    ...(sources.spendCents === undefined ? {} : { spendCents: sources.spendCents }),
    ...(sources.autonomyLevel === undefined
      ? {}
      : { autonomyLevel: sources.autonomyLevel }),
    ...(sources.readiness === undefined ? {} : { readiness: sources.readiness }),
  };
}

/** What is missing before this agent counts as managed, in the order it is asked for. */
export function passportGaps(passport: Passport): string[] {
  const gaps: string[] = [];
  if (passport.subject.roleId === undefined)
    gaps.push('no role: policy has nothing to attach to');
  if (passport.subject.principalId === undefined) gaps.push('acts for nobody');
  if (passport.owner === undefined) gaps.push('no named owner');
  if (passport.seams.length === 0) gaps.push('no seam watches it');
  if (passport.autonomyLevel === undefined) gaps.push('no level was granted');
  return gaps;
}
