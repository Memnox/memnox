import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { DEFAULT_SERVER_KEY, MCP_CONFIG_LOCATIONS, type Account } from '@memnox/core';

import { undecline } from './declined';
import {
  ENROL_FAILED,
  enrolAgent,
  revokeAgent,
  sponsorOf,
  type EnrolledAgent,
  type EnrolReporter,
} from './enrol-agent';
import { jsonServersKey } from './managed-json';
import {
  canRewrite,
  MANAGED_SERVER,
  managedServerFor,
  withManagedServer,
  withoutManagedServer,
} from './managed-server';
import {
  onboardBackupPath,
  readRecord,
  retireRecord,
  writeRecord,
  type OnboardRecord,
} from './onboarding';

/**
 * Putting an agent under Memnox, and taking it back out. The credential comes first so a
 * failed enrolment leaves the config untouched, and the backup and the record come
 * before the rewrite so a process killed between them leaves something that can undo it.
 */

export const ONBOARD = {
  DONE: 'done',
  NOT_FOUND: 'not_found',
  NO_ACCOUNT: 'no_account',
  UNSUPPORTED: 'unsupported',
  FAILED: 'failed',
} as const;

type Outcome = (typeof ONBOARD)[keyof typeof ONBOARD];

export interface OnboardResult {
  outcome: Outcome;
  record?: OnboardRecord;
  because?: string;
  /** Whether a person had to answer a browser for this one, so the screen can say. */
  approvedInBrowser?: boolean;
}

interface AgentConfig {
  product: string;
  path: string;
}

/** The file onboarding would rewrite, or why there is not one. */
export interface Manageable {
  path?: string;
  because?: string;
}

/**
 * Whether this agent can be onboarded at all, and which file would change, asked before
 * a person is so nobody answers two questions only to be told the third cannot work.
 */
export async function manageable(
  home: string,
  project: string,
  agentKind: string,
): Promise<Manageable> {
  const config = await configFor(home, project, agentKind);
  if (config === null) return { because: notFound(agentKind) };
  if (!canRewrite(config.path)) {
    return { path: config.path, because: unsupported(config) };
  }
  // A dry run of the real rewrite, because surviving a read back is stronger than parsing.
  const raw = await readFile(config.path, 'utf8');
  const trial = withManagedServer(
    raw,
    serversKeyFor(raw, config.path),
    managedServerFor('https://example.invalid/mcp', 'trial'),
    config.path,
  );
  if (trial.next === null) {
    return {
      path: config.path,
      because: trial.because ?? `${config.product} keeps a config this cannot rewrite`,
    };
  }
  return { path: config.path };
}

function notFound(agentKind: string): string {
  return `nothing on this machine keeps ${agentKind}'s servers where Memnox looks`;
}

function unsupported(config: AgentConfig): string {
  return `${config.product} keeps its config in a format this cannot rewrite safely`;
}

/** Letters only, so "Claude Code" and `claude-code` name the same product. */
function productKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, '');
}

/** Where this agent keeps its servers, matched on the product name the scan already uses. */
async function configFor(
  home: string,
  project: string,
  agentKind: string,
): Promise<AgentConfig | null> {
  const wanted = productKey(agentKind);
  for (const location of MCP_CONFIG_LOCATIONS) {
    if (productKey(location.product) !== wanted) continue;
    const path = join(location.scope === 'home' ? home : project, location.relative);
    try {
      await readFile(path, 'utf8');
      return { product: location.product, path };
    } catch {
      // Not on this machine: keep looking, since one product ships more than one location.
      continue;
    }
  }
  return null;
}

interface OnboardInput {
  home: string;
  project: string;
  account: Account;
  agentId: string;
  agentKind: string;
  report: EnrolReporter;
  /** What the person calls this agent, so the approval screen says it back to them. */
  shownAs?: string;
  now?: () => string;
}

/** The config onboarding will rewrite, read once. */
interface ReadConfig {
  config: AgentConfig;
  raw: string;
  serversKey: string;
}

export async function onboardAgent(input: OnboardInput): Promise<OnboardResult> {
  const { home, account, agentId, agentKind } = input;
  const read = await readManagedConfig(home, input.project, agentKind);
  if ('outcome' in read) return read;

  // First, because an enrolment that fails must leave the config untouched.
  const enrolled = await enrolAgent({
    sponsor: sponsorOf(account),
    agentId,
    hostname: hostOf(home),
    report: input.report,
    shownAs: input.shownAs ?? agentId,
    agentKind,
  });
  if ('outcome' in enrolled && enrolled.outcome === ENROL_FAILED) {
    return { outcome: ONBOARD.FAILED, because: enrolled.because };
  }
  if (!('machineId' in enrolled)) {
    return { outcome: ONBOARD.FAILED, because: 'the control plane said nothing' };
  }

  const now = input.now ?? ((): string => new Date().toISOString());
  const record = await backUpAndRecord(input, read.config, enrolled, now());
  const rewritten = withManagedServer(
    read.raw,
    read.serversKey,
    managedServerFor(enrolled.mcpUrl, enrolled.token),
    read.config.path,
  );
  if (rewritten.next === null) {
    return { outcome: ONBOARD.UNSUPPORTED, because: rewritten.because ?? '' };
  }
  await writeFile(read.config.path, rewritten.next, 'utf8');
  // Here rather than in the guided run, so any later onboarding clears an earlier no.
  await undecline(home, agentId);
  return { outcome: ONBOARD.DONE, record, approvedInBrowser: enrolled.approvedInBrowser };
}

/** The config to rewrite, or why onboarding stops before anything is asked of the cloud. */
async function readManagedConfig(
  home: string,
  project: string,
  agentKind: string,
): Promise<ReadConfig | OnboardResult> {
  const config = await configFor(home, project, agentKind);
  if (config === null) {
    return { outcome: ONBOARD.NOT_FOUND, because: notFound(agentKind) };
  }
  const raw = await readFile(config.path, 'utf8');
  // Never rewrite what we could not read back, the same rule `memnox mcp wrap` follows.
  if (!canRewrite(config.path)) {
    return { outcome: ONBOARD.UNSUPPORTED, because: unsupported(config) };
  }
  return { config, raw, serversKey: serversKeyFor(raw, config.path) };
}

/** The backup, then the record naming it, both before the config is touched. */
async function backUpAndRecord(
  input: OnboardInput,
  config: AgentConfig,
  enrolled: EnrolledAgent,
  at: string,
): Promise<OnboardRecord> {
  const backupPath = onboardBackupPath({
    home: input.home,
    agentId: input.agentId,
    configPath: config.path,
    at,
  });
  await mkdir(dirname(backupPath), { recursive: true });
  await copyFile(config.path, backupPath);

  const record: OnboardRecord = {
    agentId: input.agentId,
    product: config.product,
    agentKind: input.agentKind,
    configPath: config.path,
    backupPath,
    machineId: enrolled.machineId,
    // Which control plane minted it, so a move between planes cannot read this as done there.
    workspaceId: input.account.workspaceId,
    baseUrl: input.account.baseUrl,
    serverName: MANAGED_SERVER,
    onboardedAt: at,
  };
  await writeRecord(input.home, record);
  return record;
}

export const OFFBOARD = {
  DONE: 'done',
  NOT_ONBOARDED: 'not_onboarded',
  FAILED: 'failed',
} as const;

interface OffboardResult {
  outcome: (typeof OFFBOARD)[keyof typeof OFFBOARD];
  record?: OnboardRecord;
  /** Whether the credential was actually taken back, said rather than assumed. */
  revoked?: boolean;
  restoredFromBackup?: boolean;
  because?: string;
}

/**
 * Puts the config back, from the backup where it still exists, and takes the credential
 * away, because a restored config beside a live credential leaves the agent its reach.
 */
export async function offboardAgent(
  home: string,
  account: Account,
  agentId: string,
  now: () => string = () => new Date().toISOString(),
): Promise<OffboardResult> {
  const record = await readRecord(home, agentId);
  if (record === null) {
    return {
      outcome: OFFBOARD.NOT_ONBOARDED,
      because: `${agentId} is not onboarded, so there is nothing to put back`,
    };
  }

  const restoredFromBackup = await restoreBackup(record);
  if (!restoredFromBackup && !(await stripManagedEntry(record))) {
    return {
      outcome: OFFBOARD.FAILED,
      record,
      because: `could not put ${record.configPath} back; the backup is at ${record.backupPath}`,
    };
  }

  const revoked = await revokeAgent(account, record.machineId);
  await retireRecord(home, agentId, now());
  return { outcome: OFFBOARD.DONE, record, revoked, restoredFromBackup };
}

async function restoreBackup(record: OnboardRecord): Promise<boolean> {
  try {
    await writeFile(record.configPath, await readFile(record.backupPath, 'utf8'), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** The weaker undo, for a missing backup: only what onboarding added comes out. */
async function stripManagedEntry(record: OnboardRecord): Promise<boolean> {
  try {
    const raw = await readFile(record.configPath, 'utf8');
    const stripped = withoutManagedServer(
      raw,
      serversKeyFor(raw, record.configPath),
      record.configPath,
    );
    if (stripped.next !== null) await writeFile(record.configPath, stripped.next, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Which key holds the servers. Only JSON needs asking; TOML and YAML each have one spelling. */
function serversKeyFor(raw: string, path: string): string {
  if (!path.toLowerCase().endsWith('.json')) return DEFAULT_SERVER_KEY.toml;
  // Read the tolerant way the rewrite reads it, or a commented file gets a second servers block.
  return jsonServersKey(raw) ?? DEFAULT_SERVER_KEY.json;
}

/** The machine's own name, for an enrolment that has to be unique per host. */
function hostOf(home: string): string {
  const parts = home.split(/[/\\]/).filter((each) => each !== '');
  return parts[parts.length - 1] ?? 'machine';
}
