import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  conditionsForMachine,
  loadPoliciesFromFile,
  MEMNOX_HOME,
  orgConditionsPathFor,
  orgOverlaysFrom,
  readJsonFile,
  writeOrgConditions,
  DECISION_EFFECT,
  HTTP,
  POLICY_MODE,
  isCredentialRefused,
  type Account,
  type Alternative,
  type OrgCondition,
  type PolicyCarveOut,
  type PolicyMatch,
  type OrgConditionsFile,
  type Overlay,
} from '@memnox/core';

import { registerPolicyFile } from '../policy-registry';
import { callCloud } from './client';

/**
 * The rules this workspace publishes, pulled and put where the gate already looks. The
 * engine reads the file later with no network near it, so this is off the decision path.
 */

/** Written by the pull and never by hand; `memnox login` is what starts it. */
const ORG_POLICY_FILE = 'org.policies.json';
const OWNER_ONLY = 0o600;
const OWNER_ONLY_DIR = 0o700;

export interface BundleRule {
  id: string;
  policyHash: string;
  line: number;
  domain: string;
  effect: string;
  specificity: number;
  match: string;
  /** A rule's real pattern where it is narrowed; `match` then names nothing. */
  scopedMatch?: string;
  /** Every pattern it matches, where it names several or carries `conditions`; read over `match`. */
  actions?: string[];
  /** Every other condition on its match, verbatim, as `PolicyMatch` spells it. */
  conditions?: Record<string, unknown>;
  reason?: string;
  alternative?: string;
  /** Where a rule applies, when the workspace scoped it. Absent is everywhere. */
  targets?: string[];
  agents?: string[];
  workingDirectories?: string[];
  /** Where it stands aside, because an exception to it was approved. */
  unless?: PolicyCarveOut[];
  /** Its decision as published, where it says more than its effect. Read over `effect`. */
  decision?: BundleDecision;
}

/** Mode, approvers, quorum, rate limit and the rest, verbatim, with the published effect. */
export interface BundleDecision {
  effect: string;
  [field: string]: unknown;
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
 * One conditional GET, and what to do with each answer. Every failure keeps the rules
 * already on disk, so an unreachable control plane never makes a quieter gate.
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

  if (answer.status === HTTP.NOT_MODIFIED) {
    // Hearing from the plane moves the horizon, or an unedited workspace freeze would lapse.
    await touchOrgConditions(home, now());
    return { outcome: PULL_OUTCOME.UNCHANGED };
  }
  if (isCredentialRefused(answer.status)) {
    return { outcome: PULL_OUTCOME.REVOKED };
  }
  if (answer.status === HTTP.PAYMENT_REQUIRED) return { outcome: PULL_OUTCOME.LAPSED };
  if (answer.status !== HTTP.OK || answer.body === undefined) {
    return {
      outcome: PULL_OUTCOME.REFUSED,
      because: `the control plane answered ${answer.status}`,
    };
  }

  return applyBundle(home, answer.body, now, account.machineId);
}

/**
 * Whole or not at all, because a half-applied bundle is a rule set nobody wrote: staged,
 * loaded through the gate's own reader, and moved into place only once it parsed.
 */
export async function applyBundle(
  home: string,
  bundle: Bundle,
  now: () => number = Date.now,
  // Which machine this is; without one, a freeze scoped to a machine applies nowhere.
  machineId = '',
): Promise<PullResult> {
  const path = orgPolicyPath(home);
  const staging = `${path}.incoming`;
  await mkdir(dirname(path), { recursive: true, mode: OWNER_ONLY_DIR });
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

  // Renamed, which is atomic on one filesystem, so no reader sees half a rule set.
  await rename(staging, path);
  await registerPolicyFile(home, path);
  await keepConditions(home, bundle, now(), machineId);

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
    // Carried here so the next pull sends it as `If-None-Match` with no second copy.
    bundleHash: bundle.hash,
    policies: bundle.rules.filter(canHonour).flatMap((rule) => {
      const decision = decisionFor(rule);
      if (decision === null) return [];
      return [
        {
          name: rule.id,
          ...(rule.reason === undefined ? {} : { description: rule.reason }),
          match: {
            ...(rule.conditions ?? {}),
            actions: actionsOf(rule),
            ...scopeOf(rule),
          },
          decision,
        },
      ];
    }),
  };
}

const PUBLISHED_REASON = 'the workspace publishes this rule';

/**
 * The rule's decision as the gate reads it, or null where the rule is skipped. An observed
 * rule decides nothing, so it is written as published. Anything else restricted by a field
 * this gate cannot enforce is read strictly: a deny stays, an ask is refused, an allow is skipped.
 */
function decisionFor(rule: BundleRule): Record<string, unknown> | null {
  const published = rule.decision ?? { effect: rule.effect };
  const effect = typeof published.effect === 'string' ? published.effect : rule.effect;
  const reason = rule.reason ?? PUBLISHED_REASON;
  const observed = published['mode'] === POLICY_MODE.OBSERVE;
  const decision = {
    effect,
    reason,
    ...alternativeOf(rule, published),
    ...recordedFields(published),
    ...(observed ? { mode: POLICY_MODE.OBSERVE } : {}),
  };
  if (observed || !restricted(published)) return decision;
  // A missing allow never permits more, since the strictest matching rule wins.
  if (effect === DECISION_EFFECT.ALLOW) return null;
  if (effect !== DECISION_EFFECT.ASK) return decision;
  return {
    ...decision,
    effect: DECISION_EFFECT.DENY,
    reason: refusedAsk(reason, published),
  };
}

/** Fields this gate enforces as written, each with the values it can enforce. */
const ENFORCED_AS_WRITTEN: Readonly<Record<string, (value: unknown) => boolean>> = {
  reason: () => true,
  alternative: () => true,
  mode: (value) => value === POLICY_MODE.ENFORCE,
  // A hold asks whoever is at the terminal, so it can only honour naming nobody.
  approvers: (value) => Array.isArray(value) && value.length === 0,
  // A hold takes one answer.
  minApprovals: (value) => value === 1,
};

/** Whether the decision names anything this gate would have to ignore to apply it. */
function restricted(published: BundleDecision): boolean {
  return Object.entries(published).some(([field, value]) => {
    if (field === 'effect' || value === null || value === undefined) return false;
    const enforced = ENFORCED_AS_WRITTEN[field];
    return enforced === undefined || !enforced(value);
  });
}

/** Approvers, quorum and rate limit, kept on the rule where they will validate, never enforced. */
function recordedFields(published: BundleDecision): Record<string, unknown> {
  const { approvers, minApprovals, rateLimit } = published;
  const named =
    Array.isArray(approvers) && approvers.every((each) => typeof each === 'string');
  const ceiling =
    rateLimit !== null &&
    typeof rateLimit === 'object' &&
    isPositiveInteger((rateLimit as Record<string, unknown>)['max']) &&
    isPositiveInteger((rateLimit as Record<string, unknown>)['windowSeconds']);
  return {
    ...(named ? { approvers: [...(approvers as string[])] } : {}),
    ...(isPositiveInteger(minApprovals) ? { minApprovals } : {}),
    ...(ceiling ? { rateLimit: { ...(rateLimit as Record<string, unknown>) } } : {}),
  };
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

/** Why an ask became a refusal here, naming who the rule wanted asked where it named anybody. */
function refusedAsk(reason: string, published: BundleDecision): string {
  const approvers = published['approvers'];
  const why =
    Array.isArray(approvers) && approvers.length > 0
      ? `only ${approvers.map(String).join(', ')} may approve it, and a question here goes to whoever answers first`
      : 'the rule holds its question to something this machine cannot enforce';
  return `${reason.replace(/\.\s*$/, '')}. Refused on this machine, because ${why}.`;
}

/** The whole alternative where it was published whole, or the action named on the rule. */
function alternativeOf(
  rule: BundleRule,
  published: BundleDecision,
): { alternative?: Alternative } {
  const whole = published['alternative'];
  if (whole !== null && typeof whole === 'object' && !Array.isArray(whole)) {
    const { action, note, resource } = whole as Record<string, unknown>;
    const readable =
      typeof action === 'string' &&
      action !== '' &&
      typeof note === 'string' &&
      note !== '' &&
      (resource === undefined || typeof resource === 'string');
    if (readable) {
      return {
        alternative: { action, note, ...(resource === undefined ? {} : { resource }) },
      };
    }
  }
  const named = typeof whole === 'string' && whole !== '' ? whole : rule.alternative;
  return named === undefined ? {} : { alternative: { action: named, note: named } };
}

/** Every condition key this gate reads; the validator drops any other, which would widen the rule. */
const HONOURED_CONDITIONS: ReadonlySet<string> = new Set([
  'environments',
  'roles',
  'principals',
  'models',
  'providers',
  'dataClassifications',
  'jurisdictions',
  'branches',
  'arguments',
  'aboveAmount',
  'windows',
  'scope',
  'state',
  'unless',
] satisfies (keyof PolicyMatch)[]);

/** A rule naming a condition this gate would ignore is skipped: matching less, never more. */
function canHonour(rule: BundleRule): boolean {
  return Object.keys(rule.conditions ?? {}).every((key) => HONOURED_CONDITIONS.has(key));
}

/** The patterns a rule really matches, whichever spelling it was sent under. */
function actionsOf(rule: BundleRule): string[] {
  if (rule.actions !== undefined && rule.actions.length > 0) return [...rule.actions];
  return [rule.scopedMatch ?? rule.match];
}

/** Only the scope a rule carries, so an unscoped rule reads exactly as it always did. */
function scopeOf(rule: BundleRule): Record<string, unknown> {
  const unless = [...carveOutsIn(rule.conditions), ...(rule.unless ?? [])];
  return {
    ...(rule.targets === undefined ? {} : { targets: [...rule.targets] }),
    ...(rule.agents === undefined ? {} : { agents: [...rule.agents] }),
    ...(rule.workingDirectories === undefined
      ? {}
      : { workingDirectories: [...rule.workingDirectories] }),
    ...(unless.length === 0 ? {} : { unless: unless.map((carve) => ({ ...carve })) }),
  };
}

/** A rule's own carve-outs and the approved exceptions beside them both hold, so neither is lost. */
function carveOutsIn(conditions: Record<string, unknown> | undefined): PolicyCarveOut[] {
  const own = conditions === undefined ? undefined : conditions['unless'];
  // Shape is the validator's to check; anything but a list is left for it to refuse.
  return Array.isArray(own) ? (own as PolicyCarveOut[]) : [];
}

/** Only the conditions that are this machine's: a freeze of one agent names its laptop. */
async function keepConditions(
  home: string,
  bundle: Bundle,
  syncedAt: number,
  machineId: string,
): Promise<void> {
  await writeOrgConditions(home, {
    syncedAt,
    conditions: conditionsForMachine(bundle.conditions, machineId),
  });
}

/**
 * The conditions in force, as overlays, kept apart from `memnox freeze`'s file so a local
 * `--lift` cannot end a company-wide incident. Converted by core, beside the gate's reader.
 */
export function overlaysFrom(bundle: Bundle, syncedAt: number = Date.now()): Overlay[] {
  return orgOverlaysFrom({ syncedAt, conditions: bundle.conditions });
}

/** Move the horizon after a 304, keeping the conditions exactly as they were. */
async function touchOrgConditions(home: string, at: number): Promise<void> {
  const held = await readJsonFile<Partial<OrgConditionsFile>>(orgConditionsPathFor(home));
  // Nothing pulled yet, so there is no horizon to move.
  if (held === null || !Array.isArray(held.conditions)) return;
  try {
    await writeOrgConditions(home, { syncedAt: at, conditions: held.conditions });
  } catch {
    // The horizon moves on the next 304, and a pull must not fail over it.
  }
}
