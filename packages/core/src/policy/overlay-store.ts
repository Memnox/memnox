import { join } from 'node:path';
import { DAY_MS } from '../domain/time';
import { MEMNOX_HOME } from '../config/config';
import { OVERLAY_KIND, type Overlay } from './overlay';
import { readJsonArray, readJsonFile, writeJsonFile } from '../store/json-records';
import { AGENT_SUBJECT_PREFIX } from './agent-freeze';

/**
 * Where the conditions in force are kept: those declared here, and those the workspace
 * declared, in two files so `freeze --lift` on one laptop cannot end a company-wide incident.
 */
const OVERLAY_FILE = 'overlays.json';

function overlayPathFor(home: string): string {
  return join(home, MEMNOX_HOME, OVERLAY_FILE);
}

/** Lifted overlays stay in the file: what was frozen and when is part of the record. */
export async function readOverlays(home: string): Promise<Overlay[]> {
  return readJsonArray<Overlay>(overlayPathFor(home));
}

export async function writeOverlays(
  home: string,
  overlays: readonly Overlay[],
): Promise<void> {
  // Atomic, because every decision reads this and a torn read would be "nothing is frozen".
  await writeJsonFile(overlayPathFor(home), overlays);
}

/** What the control plane declared, pulled by `memnox sync` and never edited here. */
const ORG_CONDITIONS_FILE = 'org-conditions.json';

export function orgConditionsPathFor(home: string): string {
  return join(home, MEMNOX_HOME, ORG_CONDITIONS_FILE);
}

/**
 * A condition in the control plane's own field names, kept untranslated on disk so a
 * field rename is a parse error rather than a silently defaulted window.
 */
export interface OrgCondition {
  id: string;
  kind: string;
  /** Absent means the whole workspace, which reads as the subject `*`. */
  subject?: string;
  scope?: string;
  fromAt: number;
  /** Absent means open-ended, which this machine still bounds. See the grace below. */
  untilAt?: number;
}

export interface OrgConditionsFile {
  /** When this machine last heard it. An open-ended condition is bounded from here. */
  syncedAt: number;
  conditions: OrgCondition[];
}

/**
 * How long an open-ended condition outlives the last successful sync, so a freeze with
 * no end is still liftable: a machine that left the fleet releases it.
 */
export const ORG_CONDITION_GRACE_MS = DAY_MS;

/** Absent means every subject, and `*` is what a rule names to match one. */
export const WORKSPACE_WIDE = '*';

/** Separates an agent from the one machine a freeze of it is scoped to: `agent:<name>@<machine>`. */
export const MACHINE_MARK = '@';

/**
 * The conditions that are this machine's to apply. A freeze pressed on one agent's page
 * names the machine it runs on, so another laptop running the same product is untouched;
 * a condition naming no machine is everybody's, as before.
 */
export function conditionsForMachine(
  conditions: readonly OrgCondition[],
  machineId: string,
): OrgCondition[] {
  return conditions.flatMap((condition) => {
    const subject = condition.subject;
    if (subject === undefined || !subject.startsWith(AGENT_SUBJECT_PREFIX))
      return [condition];
    const at = subject.lastIndexOf(MACHINE_MARK);
    if (at === -1) return [condition];
    if (subject.slice(at + 1) !== machineId) return [];
    return [{ ...condition, subject: subject.slice(0, at) }];
  });
}

export function orgOverlaysFrom(file: OrgConditionsFile): Overlay[] {
  return file.conditions.map((condition) => ({
    id: condition.id,
    kind:
      condition.kind === OVERLAY_KIND.FREEZE
        ? OVERLAY_KIND.FREEZE
        : OVERLAY_KIND.INCIDENT,
    subject: condition.subject ?? condition.scope ?? WORKSPACE_WIDE,
    // The control plane has no reason column, so this says where it came from rather than guess.
    reason: `${condition.kind} declared for this workspace`,
    declaredAt: new Date(condition.fromAt).toISOString(),
    validUntil: new Date(
      condition.untilAt ?? file.syncedAt + ORG_CONDITION_GRACE_MS,
    ).toISOString(),
    source: 'the workspace',
  }));
}

/** Empty when not logged in or nothing was declared, which are both ordinary. */
export async function readOrgConditions(home: string): Promise<Overlay[]> {
  const file = await readJsonFile<Partial<OrgConditionsFile>>(orgConditionsPathFor(home));
  if (file === null || typeof file !== 'object') return [];
  if (!Array.isArray(file.conditions) || typeof file.syncedAt !== 'number') return [];
  try {
    return orgOverlaysFrom({ syncedAt: file.syncedAt, conditions: file.conditions });
  } catch {
    // A condition with a timestamp no date can hold is one this machine cannot bound.
    return [];
  }
}

export async function writeOrgConditions(
  home: string,
  file: OrgConditionsFile,
): Promise<void> {
  await writeJsonFile(orgConditionsPathFor(home), file);
}

/**
 * Every overlay in force: local plus workspace.
 *
 * Decision paths call this, never `readOverlays`, which is the local half alone.
 */
export async function overlaysInForce(home: string): Promise<Overlay[]> {
  const [local, org] = await Promise.all([readOverlays(home), readOrgConditions(home)]);
  return [...local, ...org];
}
