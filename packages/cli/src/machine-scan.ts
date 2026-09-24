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
  loadPolicySet,
  matchesPattern,
  MEMNOX_HOME,
  readPolicyRegistry,
  type Policy,
  type UnreadablePolicyFile,
} from '@memnox/core';
import { policyRegistryPath } from './policy-registry';

/** Scanning this machine, and asking which of what the scan found any local rule covers. */

/** The action an MCP tool call is named by, which is what a rule has to match. */
const MCP_ACTION_PREFIX = 'mcp';

/** The machine, as an argument, so a test of any command that scans never reads the real home. */
export interface ScanSeams {
  reader: MachineReader;
  lister: () => McpLister;
  snapshots: SnapshotStore;
  /** Directories the reader works in: these hold the credentials a repository has. */
  projectDirs: readonly string[];
  now: () => string;
  /** Rule files the runtime would read, so "no rule covers this" is checkable offline. */
  policyFiles: () => Promise<string[]>;
}

export function defaultScanSeams(cwd: string = process.cwd()): ScanSeams {
  const home = homedir();
  return {
    reader: new NodeMachineReader(home),
    lister: () => new NodeMcpLister(),
    snapshots: new NodeSnapshotStore(join(home, MEMNOX_HOME)),
    projectDirs: [cwd],
    now: () => new Date().toISOString(),
    policyFiles: () => readPolicyRegistry(policyRegistryPath(home)),
  };
}

interface Scan {
  report: DiscoveryReport;
  snapshot: EnvironmentSnapshot;
}

/**
 * One scan, kept. Every command that reads the machine also records what it saw, which
 * is the only reason `scan --since` has anything to compare against on the second run.
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
  // Unreadable files are carried, or a broken rule set would read as "no rule covers this".
  const rules = await loadPolicySet(await seams.policyFiles());
  const covered = new Set<string>();
  for (const name of toolNames) {
    const action = `${MCP_ACTION_PREFIX}.${name}`;
    if (rules.policies.some((policy) => matchesAction(policy, action))) covered.add(name);
  }
  return { covered: [...covered], unreadable: rules.unreadable };
}

function matchesAction(policy: Policy, action: string): boolean {
  const actions = policy.match.actions;
  if (actions === undefined || actions.length === 0) return false;
  return actions.some((pattern) => matchesPattern(pattern, action));
}
