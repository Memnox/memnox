import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  discover,
  NodeMachineReader,
  NodeMcpLister,
  NodeSnapshotStore,
  snapshotOf,
  type DiscoveryReport,
  type EnvironmentSnapshot,
  type MachineReader,
  type McpLister,
  type SnapshotStore,
} from '@memnox/core';
import { loadPolicySet, readPolicyRegistry } from '@memnox/core';
import { matchesPattern, type Policy, type UnreadablePolicyFile } from '@memnox/core';

/** Everything Memnox writes lives here, so nothing lands in a reviewed repository. */
const MEMNOX_HOME = '.memnox';
const REGISTRY_FILE = 'policies.json';
/** The action an MCP tool call is named by, which is what a rule has to match. */
const MCP_ACTION_PREFIX = 'mcp';

/**
 * The machine, as an argument. Five commands scan it — discover, diff, watch, trace and
 * readiness — and a test of any of them must never read the developer's real home.
 */
export interface ScanSeams {
  reader: MachineReader;
  lister: () => McpLister;
  snapshots: SnapshotStore;
  /** Directories the reader works in: these hold the credentials a repository has. */
  projectDirs: readonly string[];
  now: () => string;
  /** Rule files the runtime would read, so "no rule covers this" is checkable offline. */
  policyFiles: () => Promise<string[]>;
  /** What is in force, read off the same disk, so a freeze binds offline answers too. */
}

export function defaultScanSeams(cwd: string = process.cwd()): ScanSeams {
  const home = homedir();
  return {
    reader: new NodeMachineReader(home),
    lister: () => new NodeMcpLister(),
    snapshots: new NodeSnapshotStore(join(home, MEMNOX_HOME)),
    projectDirs: [cwd],
    now: () => new Date().toISOString(),
    policyFiles: () => readPolicyRegistry(join(home, MEMNOX_HOME, REGISTRY_FILE)),
  };
}

interface Scan {
  report: DiscoveryReport;
  snapshot: EnvironmentSnapshot;
}

/**
 * One scan, kept. Every command that reads the machine also records what it saw, which
 * is the only reason `diff` has anything to compare against on the second run.
 */
export async function scanMachine(
  seams: ScanSeams,
  options: { probe: boolean; save?: boolean } = { probe: true },
): Promise<Scan> {
  const now = seams.now();
  const report = await discover(seams.reader, {
    now,
    projectDirs: seams.projectDirs,
    // Starting somebody else's server is the one thing here that runs code.
    ...(options.probe ? { lister: seams.lister() } : {}),
  });
  const snapshot = snapshotOf(report, now);
  if (options.save !== false) await seams.snapshots.save(snapshot);
  return { report, snapshot };
}

/**
 * The rules in force here, or why they would not load. A report that treated a broken
 * rule set as an empty one would say "no rule covers this" about a governed machine.
 */
interface LocalRules {
  policies: Policy[];
  unreadable: UnreadablePolicyFile[];
}

async function loadLocalRules(seams: ScanSeams): Promise<LocalRules> {
  const set = await loadPolicySet(await seams.policyFiles());
  return { policies: set.policies, unreadable: set.unreadable };
}

interface RuleCoverage {
  covered: string[];
  /** Files that would not load, so a coverage count reads as a floor and not a total. */
  unreadable: UnreadablePolicyFile[];
}

/**
 * Whether any local rule reaches an MCP tool at all. An arrival nothing covers is the
 * line the report exists to print, so it is answered from the rule set rather than
 * assumed.
 */
export async function rulesCovering(
  seams: ScanSeams,
  toolNames: readonly string[],
): Promise<RuleCoverage> {
  const rules = await loadLocalRules(seams);
  const covered = new Set<string>();
  for (const name of toolNames) {
    const action = `${MCP_ACTION_PREFIX}.${name}`;
    if (rules.policies.some((policy) => reaches(policy, action))) covered.add(name);
  }
  return { covered: [...covered], unreadable: rules.unreadable };
}

function reaches(policy: Policy, action: string): boolean {
  const actions = policy.match.actions;
  if (actions === undefined || actions.length === 0) return false;
  return actions.some((pattern) => matchesPattern(pattern, action));
}

/**
 * The conditions the runtime recorded, read straight off the disk so an offline answer
 * honours the same freeze an online one would. An unreadable file yields nothing and
 * says nothing: a missing file is the first run, and every caller states separately
 * whether a rule set failed to load.
 */
