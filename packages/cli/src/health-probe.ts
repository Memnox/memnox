import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';

import {
  CONFIG_FORMAT,
  configPathFor,
  formatOf,
  JSON_SERVER_KEYS,
  LEDGER_SCAN_LIMIT,
  MCP_CONFIG_LOCATIONS,
  MEMNOX_HOME,
  POLICY_REGISTRY_FILE,
  PROXY_BINARY,
  readPolicyRegistry,
  readTextServers,
  versionPolicySet,
  interceptedBinaries,
  loadOrCreateConfig,
  loadPoliciesFromFile,
  loadPolicySet,
  type Policy,
  socketPathFor,
  LeaseRegistry,
  PendingApprovals,
  readBudgets,
  SessionPauses,
  spendReport,
  type MemnoxEvent,
  readAccount,
  type HealthFacts,
} from '@memnox/core';
import {
  askDaemon,
  INTERCEPT_BINARY,
  interceptorDirFor,
  realPath,
  resolveReal,
} from '@memnox/interceptors';

import { describeError } from './cli-errors';
import { serviceState } from './daemon/service';
import { withEvents } from './event-store';
import { POLICY_FILES } from './policy-path';
import { policyRegistryPath } from './policy-registry';

/** Reads the machine once for `doctor`, so every health check downstream stays a pure function. */

/** A liveness ping, so `doctor` never waits on a daemon that is not answering. */
const DAEMON_PING_MS = 300;

/** What a rule file is written as; anything else in the policies directory is not one. */
const RULE_SUFFIXES = ['.yaml', '.yml', '.toml', '.json'];
const POLICIES_DIR = 'policies';

type RuleFacts = Pick<
  HealthFacts,
  'rulesPath' | 'rulesError' | 'ruleCount' | 'policyVersion'
>;
type LedgerFacts = Pick<HealthFacts, 'ledgerEvents' | 'wouldHaveStopped' | 'ledgerError'>;
type HoldFacts = Pick<
  HealthFacts,
  'pausedSessions' | 'waitingApprovals' | 'heldLeases' | 'spentBudgets'
>;
type InterceptorFacts = Pick<
  HealthFacts,
  | 'interceptorsInstalled'
  | 'interceptorsExpected'
  | 'interceptorDirFirstOnPath'
  | 'interceptBinaryFound'
>;

interface ProjectRules {
  name: string;
  path: string;
  policies: Policy[];
  rulesError?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    // Absent is the ordinary case for every path here.
    return false;
  }
}

/** Reads the machine once, so every check downstream stays a pure function. */
export async function readHealth(
  home: string,
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): Promise<HealthFacts> {
  const config = await loadOrCreateConfig(home);
  // What the seams load, which is a different list from what `policy test` reads.
  const registeredFiles = await readPolicyRegistry(policyRegistryPath(home));
  const socket = await exists(socketPathFor(home));
  return {
    ...(await readHolds(home, now.toISOString())),
    configFound: await exists(configPathFor(home)),
    mode: config.mode,
    ...(await readRules(dir, registeredFiles)),
    registeredFiles,
    unregisteredRuleFiles: await unregisteredRuleFiles(home, registeredFiles),
    ...(await readInterceptors(home, env)),
    ...(await proxyWiring(home, dir)),
    daemonSocket: socket,
    daemonAnswered: socket && (await isDaemonAnswering(home)),
    enrolled: (await readAccount(home)) !== null,
    daemonStartsItself: serviceState(home).installed,
    ...(await readLedgerCounts(home)),
  };
}

async function isDaemonAnswering(home: string): Promise<boolean> {
  const reply = await askDaemon(home, {
    action: 'health.ping',
    timeoutMs: DAEMON_PING_MS,
  });
  return reply !== null;
}

/** The four things that stop work without a rule saying so. */
async function readHolds(home: string, moment: string): Promise<HoldFacts> {
  const budgets = await readBudgets(home);
  const ledgerRows = budgets.length === 0 ? [] : await readLedger(home);
  const pauses = await new SessionPauses(home).all();
  return {
    pausedSessions: pauses.filter((pause) => pause.resumedAt === undefined).length,
    waitingApprovals: (await new PendingApprovals(home).list(moment)).length,
    heldLeases: (await new LeaseRegistry(home).held(moment)).length,
    spentBudgets: spendReport(budgets, { events: ledgerRows, now: moment })
      .filter((spend) => spend.remaining === 0)
      .map((spend) => spend.budget.name),
  };
}

async function readLedgerCounts(home: string): Promise<LedgerFacts> {
  try {
    return await withEvents(home, async (store) => ({
      ledgerEvents: await store.count(),
      wouldHaveStopped: await store.countWithheld(),
    }));
  } catch (err) {
    return {
      ledgerEvents: null,
      wouldHaveStopped: 0,
      ledgerError: describeError(err),
    };
  }
}

/** Only opened when a budget could be spent; a doctor run must not cost a full scan. */
async function readLedger(home: string): Promise<MemnoxEvent[]> {
  try {
    return await withEvents(home, (store) => store.query({ limit: LEDGER_SCAN_LIMIT }));
  } catch {
    // A ledger that will not open is already reported by its own check.
    return [];
  }
}

/**
 * Both places a rule can live, or a machine governed only by the registry is reported as
 * governed by nothing. The project file is named where there is one, since that is the
 * layer a person edits, and a file that is both is counted once.
 */
async function readRules(
  dir: string,
  registeredFiles: readonly string[],
): Promise<RuleFacts> {
  const project = await readProjectRules(dir);
  // An unreadable project file is its own sentence and is not softened by a count.
  if (project?.rulesError !== undefined) {
    return {
      rulesPath: project.name,
      ruleCount: 0,
      policyVersion: 'unreadable',
      rulesError: project.rulesError,
    };
  }

  const registered = await loadRegisteredRules(registeredFiles, project?.path);
  const all = [...(project?.policies ?? []), ...registered];
  if (all.length === 0) {
    return { rulesPath: project?.name ?? null, ruleCount: 0, policyVersion: 'none' };
  }
  return {
    rulesPath: project?.name ?? POLICY_REGISTRY_FILE,
    ruleCount: all.length,
    policyVersion: versionPolicySet(all).version,
  };
}

/** What a person edits and diffs, in the directory they are standing in. */
async function readProjectRules(dir: string): Promise<ProjectRules | null> {
  for (const name of POLICY_FILES) {
    const path = join(dir, name);
    if (!(await exists(path))) continue;
    try {
      return { name, path, policies: await loadPoliciesFromFile(path) };
    } catch (err) {
      // Never reported as "no rules": that is a different sentence entirely.
      const rulesError = err instanceof Error ? err.message.split('\n')[0] : String(err);
      return { name, path, policies: [], rulesError };
    }
  }
  return null;
}

/** What the seams load, file by file, so one unreadable entry reports fewer rules rather than none. */
async function loadRegisteredRules(
  files: readonly string[],
  projectPath?: string,
): Promise<Policy[]> {
  // Counted once where the project file is also the registered one.
  const others = files.filter(
    (file) => projectPath === undefined || resolve(file) !== resolve(projectPath),
  );
  return (await loadPolicySet(others)).policies;
}

/**
 * Counts MCP servers, and how many already point at the proxy, across every place one can
 * be declared, TOML and YAML included.
 */
async function proxyWiring(
  home: string,
  dir: string,
): Promise<{ mcpServers: number; mcpWrapped: number }> {
  let servers = 0;
  let wrapped = 0;
  for (const location of MCP_CONFIG_LOCATIONS) {
    const path = join(location.scope === 'home' ? home : dir, location.relative);
    const launches = await readServerLaunches(path);
    servers += launches.length;
    wrapped += launches.filter((launch) => launch?.command === PROXY_BINARY).length;
  }
  return { mcpServers: servers, mcpWrapped: wrapped };
}

/** How each server in one config file is launched, or none where it is absent or unreadable. */
async function readServerLaunches(path: string): Promise<{ command?: string }[]> {
  if (!(await exists(path))) return [];
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return [];
  }

  const format = formatOf(path);
  if (format !== CONFIG_FORMAT.JSON) {
    return Object.values(readTextServers(format, raw).servers);
  }
  try {
    // Narrowed by the key lookup below; a missing block reads as no servers.
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Only `command` is read, and a launch without one is simply not ours.
    const block = (parsed[JSON_SERVER_KEYS[0]] ?? parsed[JSON_SERVER_KEYS[1]]) as
      Record<string, { command?: string }> | undefined;
    return block === undefined ? [] : Object.values(block);
  } catch {
    // A config we cannot parse is one we also refuse to rewrite; skip it here too.
    return [];
  }
}

async function readInterceptors(
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<InterceptorFacts> {
  const installed = await installedInterceptors(home);
  const path = (env['PATH'] ?? '').split(delimiter);
  return {
    interceptorsInstalled: installed,
    // Only what this machine has, since `protect --interceptors` wraps nothing else.
    interceptorsExpected: presentBinaries(home, env),
    // First wins on PATH, so anything before us means the real binary is found first.
    interceptorDirFirstOnPath:
      installed.length > 0 && path.indexOf(interceptorDirFor(home)) === 0,
    interceptBinaryFound: isInterceptBinaryOn(realPath(env['PATH'] ?? '', home)),
  };
}

async function installedInterceptors(home: string): Promise<string[]> {
  try {
    return await readdir(interceptorDirFor(home));
  } catch {
    // Never installed, which the check reports as inert rather than broken.
    return [];
  }
}

/**
 * Whether the binary every wrapper execs can be found on PATH. Walked here rather than
 * through `resolveReal`, which refuses this name so a wrapper never resolves to itself.
 */
function isInterceptBinaryOn(path: string): boolean {
  return path
    .split(delimiter)
    .filter((entry) => entry !== '')
    .some((entry) => existsSync(join(entry, INTERCEPT_BINARY)));
}

/**
 * The binaries the classifier knows and this machine has, resolved against the real PATH
 * with our own directory removed, or a shim resolving to itself reports them all present.
 */
function presentBinaries(home: string, env: NodeJS.ProcessEnv): string[] {
  const path = realPath(env['PATH'] ?? '', home);
  return interceptedBinaries().filter(
    (binary) => resolveReal(binary, path, existsSync) !== null,
  );
}

/**
 * Rule files in the policies directory that the registry does not name, which the seams
 * never load. Listed and never loaded, so a dropped file cannot change what is allowed.
 */
async function unregisteredRuleFiles(
  home: string,
  registeredFiles: readonly string[],
): Promise<string[]> {
  const dir = join(home, MEMNOX_HOME, POLICIES_DIR);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // No directory is no unregistered files, which is the ordinary case.
    return [];
  }
  const registered = new Set(registeredFiles.map((file) => resolve(file)));
  return entries
    .filter((name) => RULE_SUFFIXES.some((suffix) => name.endsWith(suffix)))
    .map((name) => join(dir, name))
    .filter((path) => !registered.has(resolve(path)));
}
