import { readdir, readFile, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import {
  configPathFor,
  versionPolicySet,
  interceptedBinaries,
  loadOrCreateConfig,
  loadPoliciesFromFile,
  socketPathFor,
  SqliteEventStore,
  type HealthFacts,
} from '@memnox/core';
import { askDaemon, interceptorDirFor } from '@memnox/interceptors';
import { POLICY_FILES } from './policy-path';

/** The rule files somebody might have, newest format first. */
const RULE_FILES = POLICY_FILES;

const MCP_CONFIGS = [
  '.claude.json',
  '.cursor/mcp.json',
  '.cline/settings.json',
  '.vscode/mcp.json',
];

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

/** Counts MCP servers, and how many are already pointed at the proxy. */
async function proxyWiring(
  home: string,
): Promise<{ mcpServers: number; mcpWrapped: number }> {
  let servers = 0;
  let wrapped = 0;
  for (const relative of MCP_CONFIGS) {
    const path = join(home, relative);
    if (!(await exists(path))) continue;
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      const block = (parsed['mcpServers'] ?? parsed['servers']) as
        Record<string, { command?: string }> | undefined;
      if (block === undefined) continue;
      for (const launch of Object.values(block)) {
        servers += 1;
        if (launch.command === 'memnox-mcp-proxy') wrapped += 1;
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

  return {
    configFound: await exists(configPathFor(home)),
    mode: config.mode,
    ...(await rules(dir)),
    interceptorsInstalled: installed,
    interceptorsExpected: [...interceptedBinaries()],
    // First wins on PATH, so anything before us means the real binary is found first.
    interceptorDirFirstOnPath: installed.length > 0 && path.indexOf(ours) === 0,
    ...(await proxyWiring(home)),
    daemonSocket: socket,
    daemonAnswered: answered,
    ledgerEvents,
    ...(ledgerError === undefined ? {} : { ledgerError }),
  };
}
