import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MCP_CONFIG_LOCATIONS, type Account } from '@memnox/core';
import {
  ENROL_FAILED,
  enrolAgent,
  revokeAgent,
  sponsorOf,
  type EnrolReporter,
} from './enrol-agent';
import {
  canRewrite,
  MANAGED_SERVER,
  managedServerFor,
  withManagedServer,
  withoutManagedServer,
} from './managed-server';
import { jsonServersKey } from './managed-json';
import {
  backupPathFor,
  readRecord,
  retireRecord,
  writeRecord,
  type OnboardRecord,
} from './onboarding';

/**
 * Putting an agent under Memnox, and taking it back out.
 *
 * The order is the whole design. The credential is minted first, because an
 * enrolment that fails must leave the config untouched; the backup is taken
 * before the write, because a rewrite with no backup is not reversible; and the
 * record is written before the config, because a process killed between them
 * must leave something that knows what to undo. The other orders each lose one
 * of those.
 */

export const ONBOARD = {
  DONE: 'done',
  NOT_FOUND: 'not_found',
  NO_ACCOUNT: 'no_account',
  UNSUPPORTED: 'unsupported',
  FAILED: 'failed',
} as const;

type Outcome = (typeof ONBOARD)[keyof typeof ONBOARD];

interface OnboardResult {
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
 * Whether this agent can be onboarded at all, and which file would change.
 *
 * Asked before a person is, because the alternative is answering two questions
 * about an agent and then being told the third step was never going to work. It
 * reads the same files onboarding rewrites, so the two never disagree, and the
 * path it returns is the one to put on screen: a detector proves an agent from
 * several files and only one of them is the one that would be edited.
 */
export async function manageable(
  home: string,
  project: string,
  agentKind: string,
): Promise<Manageable> {
  const config = await configFor(home, project, agentKind);
  if (config === null) {
    return {
      because: `nothing on this machine keeps ${agentKind}'s servers where Memnox looks`,
    };
  }
  if (!canRewrite(config.path)) {
    return {
      path: config.path,
      because: `${config.product} keeps its config in a format this cannot rewrite safely`,
    };
  }
  /* A dry run of the real rewrite, thrown away. Checking that the file parses
     is weaker than checking that the edit we would make survives being read
     back, and this is the one place the difference is free to find out. */
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

/**
 * Where this agent keeps its servers.
 *
 * Matched on the product name the scan already uses, so the two never disagree
 * about which file belongs to which agent.
 */
async function configFor(
  home: string,
  project: string,
  agentKind: string,
): Promise<AgentConfig | null> {
  const wanted = agentKind.toLowerCase().replace(/[^a-z]/g, '');
  for (const location of MCP_CONFIG_LOCATIONS) {
    const product = location.product.toLowerCase().replace(/[^a-z]/g, '');
    if (product !== wanted) continue;
    const path = join(location.scope === 'home' ? home : project, location.relative);
    try {
      await readFile(path, 'utf8');
      return { product: location.product, path };
    } catch {
      // A config this machine does not have: keep looking, the same product
      // ships more than one location.
      continue;
    }
  }
  return null;
}

export async function onboardAgent(
  home: string,
  project: string,
  account: Account,
  agentId: string,
  agentKind: string,
  report: EnrolReporter,
  /** What the person calls this agent, so the approval screen says it back to them. */
  shownAs: string = agentId,
  now: () => string = () => new Date().toISOString(),
): Promise<OnboardResult> {
  const config = await configFor(home, project, agentKind);
  if (config === null) {
    return {
      outcome: ONBOARD.NOT_FOUND,
      because: `nothing on this machine keeps ${agentKind}'s servers where Memnox looks`,
    };
  }

  const raw = await readFile(config.path, 'utf8');
  if (!canRewrite(config.path)) {
    /* Never rewrite what we could not read back: we would lose what it held.
       The same rule `memnox mcp wrap` follows. */
    return {
      outcome: ONBOARD.UNSUPPORTED,
      because: `${config.product} keeps its config in a format this cannot rewrite safely`,
    };
  }
  const serversKey = serversKeyFor(raw, config.path);

  /* First, because an enrolment that fails must leave the config untouched.
     It spends the credential this machine already holds where the control plane
     takes one, and asks a person only where it will not. */
  const enrolled = await enrolAgent(
    sponsorOf(account),
    agentId,
    hostOf(home),
    report,
    shownAs,
    /* The product, because the hostname beside it is hashed on the way in: the
       workspace would otherwise hold five names somebody typed and nothing
       saying which of them is Claude Code. */
    agentKind,
  );
  if ('outcome' in enrolled && enrolled.outcome === ENROL_FAILED) {
    return { outcome: ONBOARD.FAILED, because: enrolled.because };
  }
  if (!('machineId' in enrolled)) {
    return { outcome: ONBOARD.FAILED, because: 'the control plane said nothing' };
  }

  const at = now();
  const backupPath = backupPathFor(home, agentId, config.path, at);
  await mkdir(dirname(backupPath), { recursive: true });
  await copyFile(config.path, backupPath);

  const record: OnboardRecord = {
    agentId,
    product: config.product,
    /* What the control plane is told and what a console draws a mark from,
       which is not the same string a person reads. */
    agentKind,
    configPath: config.path,
    backupPath,
    machineId: enrolled.machineId,
    serverName: MANAGED_SERVER,
    onboardedAt: at,
  };
  /* Before the config, so a process killed between the two leaves a record
     pointing at a backup that exists rather than a rewrite nothing remembers. */
  await writeRecord(home, record);

  const rewritten = withManagedServer(
    raw,
    serversKey,
    managedServerFor(enrolled.mcpUrl, enrolled.token),
    config.path,
  );
  if (rewritten.next === null) {
    return { outcome: ONBOARD.UNSUPPORTED, because: rewritten.because ?? '' };
  }
  await writeFile(config.path, rewritten.next, 'utf8');

  return {
    outcome: ONBOARD.DONE,
    record,
    approvedInBrowser: enrolled.approvedInBrowser,
  };
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
 * Puts the config back and takes the credential away.
 *
 * The backup is the honest undo, because it restores exactly what was there.
 * Where it has gone missing the entry is removed instead, which is a weaker
 * answer and is said as one: anything else a person changed since stays.
 *
 * Revoking is not optional. An offboard that restored the config and left a
 * live credential would have taken the agent's *configuration* away and left
 * its *reach*, which is the wrong half.
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

  let restoredFromBackup = false;
  try {
    const backup = await readFile(record.backupPath, 'utf8');
    await writeFile(record.configPath, backup, 'utf8');
    restoredFromBackup = true;
  } catch {
    /* No backup: take out only what onboarding added, and say that this is the
       weaker undo. */
    try {
      const raw = await readFile(record.configPath, 'utf8');
      const stripped = withoutManagedServer(
        raw,
        serversKeyFor(raw, record.configPath),
        record.configPath,
      );
      if (stripped.next !== null)
        await writeFile(record.configPath, stripped.next, 'utf8');
    } catch {
      return {
        outcome: OFFBOARD.FAILED,
        record,
        because: `could not put ${record.configPath} back; the backup is at ${record.backupPath}`,
      };
    }
  }

  const revoked = await revokeAgent(account, record.machineId);
  await retireRecord(home, agentId, now());
  return { outcome: OFFBOARD.DONE, record, revoked, restoredFromBackup };
}

/**
 * Which key holds the servers, for the one format with two spellings in the wild.
 *
 * Only JSON needs asking: TOML and YAML each have one spelling their own tooling
 * goes by, and their modules decide it rather than being told.
 */
function serversKeyFor(raw: string, path: string): string {
  if (!path.toLowerCase().endsWith('.json')) return 'mcp_servers';
  /* Read the tolerant way the rewrite reads it: a config with a comment in it
     would otherwise fall back to the default spelling and add a second servers
     block beside the one the file already has. */
  return jsonServersKey(raw) ?? 'mcpServers';
}

/** The machine's own name, for an enrolment that has to be unique per host. */
function hostOf(home: string): string {
  const parts = home.split(/[/\\]/).filter((each) => each !== '');
  return parts[parts.length - 1] ?? 'machine';
}
