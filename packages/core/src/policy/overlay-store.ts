import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MEMNOX_HOME } from '../config/config';
import { OVERLAY_KIND, type Overlay } from './overlay';

const OVERLAY_FILE = 'overlays.json';

function overlayPathFor(home: string): string {
  return join(home, MEMNOX_HOME, OVERLAY_FILE);
}

/** Lifted overlays stay in the file: what was frozen and when is part of the record. */
export async function readOverlays(home: string): Promise<Overlay[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(overlayPathFor(home), 'utf8'));
    return Array.isArray(parsed) ? (parsed as Overlay[]) : [];
  } catch {
    // Nothing has ever been frozen here, which is the ordinary case.
    return [];
  }
}

export async function writeOverlays(home: string, overlays: Overlay[]): Promise<void> {
  const path = overlayPathFor(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(overlays, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

/**
 * What the control plane declared, pulled by `memnox sync` and never edited here.
 *
 * Its own file because `freeze --lift` is a read-modify-write of the local one: a
 * company-wide incident living in that file could be ended by one developer running
 * a command about their own laptop.
 */
const ORG_CONDITIONS_FILE = 'org-conditions.json';

export function orgConditionsPathFor(home: string): string {
  return join(home, MEMNOX_HOME, ORG_CONDITIONS_FILE);
}

/**
 * A condition exactly as the control plane sends it.
 *
 * Stored in the control plane's own field names rather than translated on the way
 * in. The two halves were written against each other's documentation and not each
 * other: this said `from` and `until`, the wire says `fromAt` and `untilAt`, so
 * every pulled condition arrived with no window at all and was given a default one.
 * Keeping the wire shape on disk is what makes that class of drift a parse error
 * instead of a silent default.
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
 * How long an open-ended condition outlives the last successful sync.
 *
 * The control plane may declare a freeze with no end, and a machine that honoured
 * that literally could never be unfrozen — the sibling failure to a freeze that
 * lapses. So it holds while the machine is in touch and for a day after it stops,
 * and every sync pushes the horizon out again. A machine that has left the fleet
 * releases; one on a closed laptop over a weekend does not.
 */
export const ORG_CONDITION_GRACE_MS = 24 * 60 * 60 * 1000;

/** Absent means every subject, and `*` is what a rule names to match one. */
export const WORKSPACE_WIDE = '*';

export function orgOverlaysFrom(file: OrgConditionsFile): Overlay[] {
  return file.conditions.map((condition) => ({
    id: condition.id,
    kind:
      condition.kind === OVERLAY_KIND.FREEZE
        ? OVERLAY_KIND.FREEZE
        : OVERLAY_KIND.INCIDENT,
    subject: condition.subject ?? condition.scope ?? WORKSPACE_WIDE,
    /* The control plane has no reason column, so this says where it came from rather
       than inventing why. A refusal that guessed the reason would be worse. */
    reason: `${condition.kind} declared for this workspace`,
    declaredAt: new Date(condition.fromAt).toISOString(),
    validUntil: new Date(
      condition.untilAt ?? file.syncedAt + ORG_CONDITION_GRACE_MS,
    ).toISOString(),
    source: 'the workspace',
  }));
}

export async function readOrgConditions(home: string): Promise<Overlay[]> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(orgConditionsPathFor(home), 'utf8'),
    );
    const file = parsed as Partial<OrgConditionsFile>;
    if (!Array.isArray(file.conditions) || typeof file.syncedAt !== 'number') return [];
    return orgOverlaysFrom({ syncedAt: file.syncedAt, conditions: file.conditions });
  } catch {
    // Not logged in, or nothing declared for the workspace. Both are ordinary.
    return [];
  }
}

export async function writeOrgConditions(
  home: string,
  file: OrgConditionsFile,
): Promise<void> {
  const path = orgConditionsPathFor(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

/**
 * Everything in force here: what somebody declared on this machine, and what the
 * workspace declared for every machine.
 *
 * Every decision path reads this and `readOverlays` reads only the local half. The
 * pulled file was written, reported as applied, and consulted by nothing — a
 * production freeze reached every laptop and governed none of them, because the one
 * function the gates call had never been told the second file existed.
 */
export async function overlaysInForce(home: string): Promise<Overlay[]> {
  const [local, org] = await Promise.all([readOverlays(home), readOrgConditions(home)]);
  return [...local, ...org];
}
