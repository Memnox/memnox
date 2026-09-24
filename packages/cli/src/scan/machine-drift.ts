/**
 * What arrived on this machine since the last look: one comparison, shared by the
 * foreground `memnox watch` and the daemon, so the two never disagree about drift.
 */
import {
  agentUpdates,
  alertsFor,
  compareSnapshots,
  discoverDefinitions,
  lastProbed,
  readAcceptedSkills,
  reviewSkills,
  SKILL_STANDING,
  snapshotOf,
  withToolsFrom,
  type Alert,
  type CredentialFinding,
  type DiscoveryReport,
  type EnvironmentChange,
  type EnvironmentSnapshot,
  type SkillFinding,
  type VersionChange,
} from '@memnox/core';

import { scanMachine, type ScanSeams } from '../machine-scan';

/** What the next look compares against. A null field has never been looked at. */
export interface DriftBaseline {
  snapshot: EnvironmentSnapshot | null;
  /** Credential paths present at the last look, because a login touches no agent config. */
  credentials: readonly string[] | null;
  /** Definition ids seen at the last look, because the snapshot does not carry them. */
  definitions: readonly string[] | null;
}

/** One look at the machine, with what a comparison needs from it. */
interface MachineLook {
  report: DiscoveryReport;
  snapshot: EnvironmentSnapshot;
  definitions: SkillFinding[];
}

/** Everything that moved since the baseline, sorted into what a person acts on. */
export interface Drift {
  changes: EnvironmentChange[];
  alerts: Alert[];
  updates: VersionChange[];
  logins: CredentialFinding[];
  arrived: SkillFinding[];
}

/**
 * Scans, and reviews the definitions the snapshot does not hold. With no probe, the tools
 * come from the last scan that asked, so an unprobed look is not read as tools removed.
 */
export async function lookAtMachine(
  seams: ScanSeams,
  options: { probe: boolean; save?: boolean },
): Promise<MachineLook> {
  const { report, snapshot } = await scanMachine(seams, options);
  const definitions = await reviewDefinitions(seams);
  if (options.probe) return { report, snapshot, definitions };
  const probed = lastProbed(await seams.snapshots.history());
  const surfaces = withToolsFrom(report.surfaces, probed);
  return {
    report,
    snapshot: snapshotOf({ ...report, surfaces }, snapshot.takenAt),
    definitions,
  };
}

/** What moved since the baseline. Each part stays empty until its own half was looked at. */
export function driftSince(baseline: DriftBaseline, look: MachineLook): Drift {
  const before = baseline.snapshot;
  const changes = before === null ? [] : compareSnapshots(before, look.snapshot);
  return {
    changes,
    alerts: alertsFor(changes),
    // Reported even when nothing else moved, because nobody granted the difference.
    updates: before === null ? [] : agentUpdates(before, look.snapshot),
    logins: newCredentials(baseline.credentials, look.report),
    arrived: sinceLastLook(baseline.definitions, look.definitions),
  };
}

/** This look, as the baseline the next one compares against. */
export function baselineOf(look: MachineLook): DriftBaseline {
  return {
    snapshot: look.snapshot,
    credentials: look.report.credentials.map((each) => each.path),
    definitions: look.definitions.map((each) => each.id),
  };
}

export function isQuiet(drift: Drift): boolean {
  return (
    drift.changes.length +
      drift.updates.length +
      drift.logins.length +
      drift.arrived.length ===
    0
  );
}

/**
 * What the agents here run on beyond their config, against what anybody accepted. A
 * failure reports nothing rather than stopping the look that reports everything else.
 */
async function reviewDefinitions(seams: ScanSeams): Promise<SkillFinding[]> {
  try {
    const found = await discoverDefinitions(seams.reader);
    return reviewSkills(found, await readAcceptedSkills(seams.reader.homeDir()));
  } catch {
    return [];
  }
}

/** The ones that arrived since the last look; what was already there is `memnox skills`. */
function sinceLastLook(
  seen: readonly string[] | null,
  findings: readonly SkillFinding[],
): SkillFinding[] {
  if (seen === null) return [];
  return findings.filter(
    (each) => each.standing !== SKILL_STANDING.KNOWN && !seen.includes(each.id),
  );
}

/** Credentials present now that were not there at the last look. A login is an event. */
function newCredentials(
  had: readonly string[] | null,
  after: DiscoveryReport,
): CredentialFinding[] {
  if (had === null) return [];
  return after.credentials.filter((each) => !had.includes(each.path));
}
