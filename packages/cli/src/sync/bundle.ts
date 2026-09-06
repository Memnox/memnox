import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  loadPoliciesFromFile,
  MEMNOX_HOME,
  orgConditionsPathFor,
  orgOverlaysFrom,
  writeOrgConditions,
  type OrgCondition,
  type OrgConditionsFile,
  type Overlay,
} from '@memnox/core';
import { registerPolicyFile } from '../policy-registry';
import type { Account } from '@memnox/core';
import { callCloud } from './client';

/**
 * The rules this workspace publishes, pulled and put where the gate already
 * looks. Nothing here is on the decision path: the engine reads the file this
 * writes, minutes or hours later, with no network anywhere near it.
 */

/** Written by the pull and never by hand; `memnox login` is what starts it. */
const ORG_POLICY_FILE = 'org.policies.json';
const OWNER_ONLY = 0o600;

export interface BundleRule {
  id: string;
  policyHash: string;
  line: number;
  domain: string;
  effect: string;
  specificity: number;
  match: string;
  reason?: string;
  alternative?: string;
}

/** The control plane's shape, kept as it arrives. `OrgCondition` is the same row. */
export type BundleCondition = OrgCondition;

export interface Bundle {
  hash: string;
  policies: { hash: string; layer: string; content: string }[];
  rules: BundleRule[];
  conditions: BundleCondition[];
  tags: unknown[];
}

export const PULL_OUTCOME = {
  /** 304: this machine already holds it. The common answer. */
  UNCHANGED: 'unchanged',
  APPLIED: 'applied',
  /** It arrived and would not load. The previous bundle stays in force. */
  REFUSED: 'refused',
  /** The credential is gone. Stop pulling; the rules on disk stay. */
  REVOKED: 'revoked',
  /** The plan lapsed. Same answer: the rules on disk stay. */
  LAPSED: 'lapsed',
} as const;

export type PullOutcome = (typeof PULL_OUTCOME)[keyof typeof PULL_OUTCOME];

export interface PullResult {
  outcome: PullOutcome;
  hash?: string;
  rules?: number;
  conditions?: number;
  /** Why a bundle was refused, in the words `doctor` prints. */
  because?: string;
}

export function orgPolicyPath(home: string): string {
  return join(home, MEMNOX_HOME, ORG_POLICY_FILE);
}

/** Re-exported so the sync tests and `doctor` name the same file the gate reads. */
export const orgConditionsPath = orgConditionsPathFor;

/**
 * One conditional GET, and what to do with each answer.
 *
 * Every failure keeps the rules already on disk. A machine that cannot reach its
 * control plane is a machine that carries on enforcing what it last agreed to —
 * anything else would make a flaky network into a quieter gate.
 */
export async function pullBundle(
  home: string,
  account: Account,
  held?: string,
  now: () => number = Date.now,
): Promise<PullResult> {
  const answer = await callCloud<Bundle>({
    baseUrl: account.baseUrl,
    path: `/v1/workspaces/${account.workspaceId}/bundle`,
    token: account.token,
    ...(held === undefined ? {} : { ifNoneMatch: held }),
  });

  if (answer.status === 304) {
    /* An unchanged bundle still moves the horizon an open-ended condition is held
       to: the machine has just heard from the control plane, which is the whole
       evidence that horizon stands on. Without this a workspace freeze that nobody
       edited would lapse a day later on every machine still faithfully syncing. */
    await touchOrgConditions(home, now());
    return { outcome: PULL_OUTCOME.UNCHANGED };
  }
  if (answer.status === 401 || answer.status === 403) {
    return { outcome: PULL_OUTCOME.REVOKED };
  }
  if (answer.status === 402) return { outcome: PULL_OUTCOME.LAPSED };
  if (answer.status !== 200 || answer.body === undefined) {
    return {
      outcome: PULL_OUTCOME.REFUSED,
      because: `the control plane answered ${answer.status}`,
    };
  }

  return applyBundle(home, answer.body);
}

/**
 * Whole or not at all.
 *
 * A bundle that half-applies is a rule set nobody wrote: some rules from today,
 * some from last week, and no way to say which. So it is written to a temporary
 * file, loaded through the same reader the gate uses, and only moved into place
 * once it has parsed.
 */
export async function applyBundle(
  home: string,
  bundle: Bundle,
  now: () => number = Date.now,
): Promise<PullResult> {
  const path = orgPolicyPath(home);
  const staging = `${path}.incoming`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(staging, JSON.stringify(documentFrom(bundle), null, 2), {
    encoding: 'utf8',
    mode: OWNER_ONLY,
  });

  try {
    // The gate's own loader, so a bundle this accepts is one the gate can read.
    await loadPoliciesFromFile(staging);
  } catch (err) {
    // Leaving it would put a rule set the gate rejected next to the one in force.
    await rm(staging, { force: true });
    return {
      outcome: PULL_OUTCOME.REFUSED,
      hash: bundle.hash,
      because: err instanceof Error ? err.message : String(err),
    };
  }

  /* Renamed rather than rewritten: on the same filesystem it is atomic, so a
     reader between the two never sees a half-written rule set. */
  await rename(staging, path);
  await registerPolicyFile(home, path);
  await writeOrgConditions(home, { syncedAt: now(), conditions: bundle.conditions });

  return {
    outcome: PULL_OUTCOME.APPLIED,
    hash: bundle.hash,
    rules: bundle.rules.length,
    conditions: bundle.conditions.length,
  };
}

/** The bundle's rules as the policy document the gate already reads. */
export function documentFrom(bundle: Bundle): unknown {
  return {
    version: 1,
    /* Carried in the file so the next pull can send it as `If-None-Match`
       without a second place to keep it in step. */
    bundleHash: bundle.hash,
    policies: bundle.rules.map((rule) => ({
      name: rule.id,
      ...(rule.reason === undefined ? {} : { description: rule.reason }),
      match: { actions: [rule.match] },
      decision: {
        effect: rule.effect,
        reason: rule.reason ?? 'the workspace publishes this rule',
        ...(rule.alternative === undefined
          ? {}
          : { alternative: { action: rule.alternative, note: rule.alternative } }),
      },
    })),
  };
}

/**
 * The conditions in force, as overlays.
 *
 * Their own file rather than the one `memnox freeze` writes: a local
 * `freeze --lift` reads that file, marks everything active as lifted and writes
 * it back, which would quietly end an incident somebody declared for the whole
 * company.
 *
 * The conversion itself lives beside the reader in core, so the gate and this
 * agree on what a condition means by construction rather than by review.
 */
export function overlaysFrom(bundle: Bundle, syncedAt: number = Date.now()): Overlay[] {
  return orgOverlaysFrom({ syncedAt, conditions: bundle.conditions });
}

/** Move the horizon after a 304, keeping the conditions exactly as they were. */
async function touchOrgConditions(home: string, at: number): Promise<void> {
  try {
    const held = JSON.parse(
      await readFile(orgConditionsPathFor(home), 'utf8'),
    ) as Partial<OrgConditionsFile>;
    if (!Array.isArray(held.conditions)) return;
    await writeOrgConditions(home, { syncedAt: at, conditions: held.conditions });
  } catch {
    // Nothing pulled yet, so there is no horizon to move.
  }
}
