import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import {
  CONFIG_FORMAT,
  configPathFor,
  formatOf,
  MCP_CONFIG_LOCATIONS,
  PROXY_BINARY,
  readPolicyRegistry,
  readTextServers,
  versionPolicySet,
  interceptedBinaries,
  loadOrCreateConfig,
  loadPoliciesFromFile,
  type Policy,
  socketPathFor,
  LeaseRegistry,
  PendingApprovals,
  readBudgets,
  SessionPauses,
  spendReport,
  SqliteEventStore,
  type MemnoxEvent,
  type HealthFacts,
} from '@memnox/core';
import {
  askDaemon,
  interceptorDirFor,
  realPath,
  resolveReal,
} from '@memnox/interceptors';
import { POLICY_FILES } from './policy-path';
import { policyRegistryPath } from './policy-registry';

/** The rule files somebody might have, newest format first. */
const RULE_FILES = POLICY_FILES;
/** The Memnox home, as every other path here spells it. */
const MEMNOX_HOME = '.memnox';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    // Absent is the ordinary case for every path here.
    return false;
  }
}

/**
 * Both places a rule can live, because a machine governed only by the registry
 * was reported as governed by nothing.
 *
 * This walked the project's own rule files and stopped there, so every rule
 * `memnox protect --apply` writes — into `~/.memnox/policies/`, registered in
 * `policies.json`, and loaded by every seam — was invisible here. A laptop with
 * four denies actually in force was told "no rules, so every action is allowed",
 * which is the one sentence this check exists to avoid printing wrongly: it is a
 * false all-clear about the thing the product is for.
 *
 * The project file is still named where there is one, because that is the layer a
 * person edits and diffs. The registry is added to the count rather than replacing
 * it, and a file that is both is counted once.
 */
async function rules(
  dir: string,
  home: string,
): Promise<
  Pick<HealthFacts, 'rulesPath' | 'rulesError' | 'ruleCount' | 'policyVersion'>
> {
  const project = await projectRules(dir);
  // An unreadable project file is its own sentence and is not softened by a count.
  if (project !== null && project.rulesError !== undefined) {
    return {
      rulesPath: project.name,
      ruleCount: 0,
      policyVersion: 'unreadable',
      rulesError: project.rulesError,
    };
  }

  const registered = await registeredRules(home, project?.path);
  const all = [...(project?.policies ?? []), ...registered];
  if (all.length === 0) {
    return project === null
      ? { rulesPath: null, ruleCount: 0, policyVersion: 'none' }
      : { rulesPath: project.name, ruleCount: 0, policyVersion: 'none' };
  }
  return {
    rulesPath: project === null ? POLICY_REGISTRY_NAME : project.name,
    ruleCount: all.length,
    policyVersion: versionPolicySet(all).version,
  };
}

/** What a person edits and diffs, in the directory they are standing in. */
async function projectRules(dir: string): Promise<{
  name: string;
  path: string;
  policies: Policy[];
  rulesError?: string;
} | null> {
  for (const name of RULE_FILES) {
    const path = join(dir, name);
    if (!(await exists(path))) continue;
    try {
      return { name, path, policies: await loadPoliciesFromFile(path) };
    } catch (err) {
      // Never reported as "no rules": that is a different sentence entirely.
      return {
        name,
        path,
        policies: [],
        rulesError: err instanceof Error ? err.message.split('\n')[0] : String(err),
      };
    }
  }
  return null;
}

/**
 * What the seams actually load, file by file.
 *
 * One unreadable entry never blanks the rest, the same rule `policySetInForce`
 * follows: a stale file in the registry is a reason to report fewer rules, not a
 * reason to report none on a machine that has them.
 */
async function registeredRules(home: string, projectPath?: string): Promise<Policy[]> {
  let files: string[];
  try {
    files = await readPolicyRegistry(policyRegistryPath(home));
  } catch {
    return [];
  }
  const found: Policy[] = [];
  for (const file of files) {
    // Counted once where the project file is also the registered one.
    if (projectPath !== undefined && resolve(file) === resolve(projectPath)) continue;
    try {
      found.push(...(await loadPoliciesFromFile(file)));
    } catch {
      // Reported by `memnox policy check`; here it is simply not in force.
    }
  }
  return found;
}

/** What the registry is called, for the line that says where rules came from. */
const POLICY_REGISTRY_NAME = 'policies.json';

/**
 * Counts MCP servers, and how many are already pointed at the proxy — across every
 * place one can be declared, TOML and YAML included. Reading a shorter list here is
 * how this check came to report "none routed" on a machine where most of them were.
 */
async function proxyWiring(
  home: string,
  dir: string,
): Promise<{ mcpServers: number; mcpWrapped: number }> {
  let servers = 0;
  let wrapped = 0;
  for (const location of MCP_CONFIG_LOCATIONS) {
    const path = join(location.scope === 'home' ? home : dir, location.relative);
    if (!(await exists(path))) continue;

    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      continue;
    }

    const format = formatOf(path);
    if (format !== CONFIG_FORMAT.JSON) {
      for (const launch of Object.values(readTextServers(format, raw).servers)) {
        servers += 1;
        if (launch.command === PROXY_BINARY) wrapped += 1;
      }
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const block = (parsed['mcpServers'] ?? parsed['servers']) as
        Record<string, { command?: string }> | undefined;
      if (block === undefined) continue;
      for (const launch of Object.values(block)) {
        servers += 1;
        if (launch.command === PROXY_BINARY) wrapped += 1;
      }
    } catch {
      // A config we cannot parse is one we also refuse to rewrite; skip it here too.
      continue;
    }
  }
  return { mcpServers: servers, mcpWrapped: wrapped };
}

async function installedInterceptors(home: string): Promise<string[]> {
  try {
    return await readdir(interceptorDirFor(home));
  } catch {
    // Never installed, which the check reports as inert rather than broken.
    return [];
  }
}

/** Reads the machine once, so every check downstream stays a pure function. */
export async function gatherHealth(
  home: string,
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HealthFacts> {
  const config = await loadOrCreateConfig(home);
  const installed = await installedInterceptors(home);
  const ours = interceptorDirFor(home);
  const path = (env['PATH'] ?? '').split(delimiter);

  const socket = await exists(socketPathFor(home));
  const answered =
    socket && (await askDaemon(home, { action: 'health.ping', timeoutMs: 300 })) !== null;

  let ledgerEvents: number | null = null;
  let ledgerError: string | undefined;
  try {
    const store = SqliteEventStore.forHome(home);
    ledgerEvents = await store.count();
    store.close();
  } catch (err) {
    ledgerError = err instanceof Error ? err.message : String(err);
  }

  const moment = new Date().toISOString();
  const budgets = await readBudgets(home);
  const ledgerRows = budgets.length === 0 ? [] : await readLedger(home);

  return {
    /* The four things that stop work without a rule saying so. Read here with
       everything else, so every check downstream stays a pure function. */
    pausedSessions: (await new SessionPauses(home).all()).filter(
      (pause) => pause.resumedAt === undefined,
    ).length,
    waitingApprovals: (await new PendingApprovals(home).list(moment)).length,
    heldLeases: (await new LeaseRegistry(home).held(moment)).length,
    spentBudgets: spendReport(budgets, ledgerRows, moment)
      .filter((spend) => spend.remaining === 0)
      .map((spend) => spend.budget.name),
    configFound: await exists(configPathFor(home)),
    mode: config.mode,
    ...(await rules(dir, home)),
    // What the seams load, which is a different list from what `policy test` reads.
    registeredFiles: await readPolicyRegistry(policyRegistryPath(home)),
    unregisteredRuleFiles: await unregisteredRuleFiles(home),
    interceptorsInstalled: installed,
    // Only what this machine has; see the field's note on the loop that caused.
    interceptorsExpected: presentBinaries(home, env),
    // First wins on PATH, so anything before us means the real binary is found first.
    interceptorDirFirstOnPath: installed.length > 0 && path.indexOf(ours) === 0,
    ...(await proxyWiring(home, dir)),
    daemonSocket: socket,
    daemonAnswered: answered,
    ledgerEvents,
    ...(ledgerError === undefined ? {} : { ledgerError }),
  };
}

/** Only opened when a budget could be spent; a doctor run must not cost a full scan. */
async function readLedger(home: string): Promise<MemnoxEvent[]> {
  try {
    const store = SqliteEventStore.forHome(home);
    try {
      return await store.query({ limit: 20_000 });
    } finally {
      store.close();
    }
  } catch {
    // A ledger that will not open is already reported by its own check.
    return [];
  }
}

/**
 * The binaries the classifier knows *and* this machine has.
 *
 * Resolved against the real PATH with our own directory taken out, exactly as the
 * installer does it — a shim resolving to itself would report every binary present on
 * a machine that had none of them.
 */
function presentBinaries(home: string, env: NodeJS.ProcessEnv): string[] {
  const path = realPath(env['PATH'] ?? '', home);
  return interceptedBinaries().filter(
    (binary) => resolveReal(binary, path, existsSync) !== null,
  );
}

/**
 * Rule files in the policies directory that the registry does not name.
 *
 * `policies.json` is what the seams read, so a file dropped beside the ones
 * `memnox protect` wrote is loaded by nothing and says nothing about it. The
 * person who hand-wrote a rule has every reason to believe it is in force.
 *
 * Listed, never loaded: picking up whatever appears in a directory would let a
 * file somebody dropped there change what this machine allows, which is a
 * different and much worse thing than a rule that does nothing.
 */
async function unregisteredRuleFiles(home: string): Promise<string[]> {
  const dir = join(home, MEMNOX_HOME, POLICIES_DIR);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // No directory is no unregistered files, which is the ordinary case.
    return [];
  }
  let registered: Set<string>;
  try {
    registered = new Set(
      (await readPolicyRegistry(policyRegistryPath(home))).map((file) => resolve(file)),
    );
  } catch {
    return [];
  }
  return entries
    .filter((name) => RULE_SUFFIXES.some((suffix) => name.endsWith(suffix)))
    .map((name) => join(dir, name))
    .filter((path) => !registered.has(resolve(path)));
}

/** What a rule file is written as; anything else in there is not one. */
const RULE_SUFFIXES = ['.yaml', '.yml', '.toml', '.json'];
const POLICIES_DIR = 'policies';
