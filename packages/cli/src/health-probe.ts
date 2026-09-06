import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
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

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    // Absent is the ordinary case for every path here.
    return false;
  }
}

async function rules(
  dir: string,
): Promise<
  Pick<HealthFacts, 'rulesPath' | 'rulesError' | 'ruleCount' | 'policyVersion'>
> {
  for (const name of RULE_FILES) {
    const path = join(dir, name);
    if (!(await exists(path))) continue;
    try {
      const policies = await loadPoliciesFromFile(path);
      return {
        rulesPath: name,
        ruleCount: policies.length,
        policyVersion: versionPolicySet(policies).version,
      };
    } catch (err) {
      // Never reported as "no rules": that is a different sentence entirely.
      return {
        rulesPath: name,
        ruleCount: 0,
        policyVersion: 'unreadable',
        rulesError: err instanceof Error ? err.message.split('\n')[0] : String(err),
      };
    }
  }
  return { rulesPath: null, ruleCount: 0, policyVersion: 'none' };
}

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
    ...(await rules(dir)),
    // What the seams load, which is a different list from what `policy test` reads.
    registeredFiles: await readPolicyRegistry(policyRegistryPath(home)),
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
