/**
 * The daemon's half of `memnox watch`: capability drift found while nobody is watching,
 * one desktop notice per kind of change, and every change kept in the ledger.
 */
import { join } from 'node:path';

import {
  alertsFor,
  ALERT,
  CHANGE_DIRECTION,
  CHANGE_SUBJECT,
  describeSkill,
  describeUpdate,
  MEMNOX_HOME,
  NodeMachineReader,
  NodeSnapshotStore,
  readPolicyRegistry,
  TOOL_CLASS,
  watchedRepositories,
  type EnvironmentChange,
  type McpLister,
  isServerGone,
} from '@memnox/core';

import type { ScanSeams } from '../machine-scan';
import { policyRegistryPath } from '../policy-registry';
import type { Drift } from '../scan/machine-drift';
import { CONFIG_RULE, type ConfigRecord } from './config-events';
import { SESSION_SERVER } from '../session-tools/session-entry';

/** The kinds of drift worth a notice, each of which a person acts on differently. */
export const DRIFT_GROUP = {
  WIDENED: 'widened',
  NEW_SERVER: 'new-server',
  NEW_WRITE_TOOL: 'new-write-tool',
  CREDENTIAL: 'credential',
  SELF_UPDATE: 'self-update',
  DEFINITION: 'definition',
  SERVER_GONE: 'server-gone',
  /** An agent may now do more in a system, a CLI logged in, or a credential names production. */
  AUTHORITY: 'authority',
} as const;

export type DriftGroup = (typeof DRIFT_GROUP)[keyof typeof DRIFT_GROUP];

/** One change the daemon noticed, as both a notice and a ledger row read it. */
export interface DriftItem {
  group: DriftGroup;
  name: string;
  agent?: string;
  file?: string;
  summary: string;
  /** What the change brought, such as "14 tools · 11 read · 3 write". */
  detail?: string;
}

/** The arrow a comparison writes between a before and an after, as in "1 → 3 agents". */
const MOVED_TO = '→';

/** A pass that finds more than this says the rest in one line, because a flood gets muted. */
export const MOST_NOTICES_PER_PASS = 3;

/** Names past this in one notice are counted, since a notice is read in a glance. */
const NAMES_PER_NOTICE = 3;

/** The ledger's word for each group, under `config.drift.` so a timeline filter can find them. */
const DRIFT_OPERATION_PREFIX = 'config.drift.';

/** Which group each alert belongs to. An alert with no row here is not worth a notice. */
const GROUP_OF_ALERT: Readonly<Record<string, DriftGroup>> = {
  [ALERT.CREDENTIAL_EXPOSED]: DRIFT_GROUP.CREDENTIAL,
  [ALERT.NEW_SERVER]: DRIFT_GROUP.NEW_SERVER,
  [ALERT.NEW_WRITE_TOOL]: DRIFT_GROUP.NEW_WRITE_TOOL,
  [ALERT.AGENT_WIDENED]: DRIFT_GROUP.WIDENED,
  [ALERT.HARNESS_WIDENED]: DRIFT_GROUP.WIDENED,
  [ALERT.SERVER_GONE]: DRIFT_GROUP.SERVER_GONE,
};

/** Never a lister that starts anything: the daemon reads configs and never runs a server. */
const NO_PROBE: McpLister = { listTools: async () => [] };

/** The machine under this home, read only, and never saving a scan into the kept history. */
export function keeperScanSeams(home: string, now: () => Date): ScanSeams {
  return {
    reader: new NodeMachineReader(home),
    lister: () => NO_PROBE,
    snapshots: new NodeSnapshotStore(join(home, MEMNOX_HOME)),
    projectDirs: watchedRepositories(home),
    now: () => now().toISOString(),
    policyFiles: () => readPolicyRegistry(policyRegistryPath(home)),
  };
}

/** Every change worth a person's attention, in the order they should hear it. */
export function driftItems(drift: Drift): DriftItem[] {
  return [
    ...drift.changes.flatMap(itemOfChange),
    ...drift.logins.map((login) => ({
      group: DRIFT_GROUP.CREDENTIAL,
      name: login.kind,
      file: login.path,
      summary: `${login.kind} logged in. before: no credential at ${login.path}; after: one`,
    })),
    ...drift.updates.map((update) => ({
      group: DRIFT_GROUP.SELF_UPDATE,
      name: update.agent,
      agent: update.agent,
      summary: describeUpdate(update),
    })),
    ...drift.arrived.map((one) => ({
      group: DRIFT_GROUP.DEFINITION,
      name: one.name,
      agent: one.agent,
      file: one.path,
      summary: describeSkill(one),
    })),
  ];
}

/** A change is an item when it raised an alert, or when an agent gained a whole surface. */
function itemOfChange(change: EnvironmentChange): DriftItem[] {
  if (isServerGone(change)) return [goneItem(change)];
  if (change.direction !== CHANGE_DIRECTION.WIDENS) return [];
  // Our own session tools, which setup put there: announcing them as new would be noise.
  if (change.name === SESSION_SERVER) return [];
  const [alert] = alertsFor([change]);
  const group =
    alert === undefined
      ? change.subject === CHANGE_SUBJECT.SURFACE
        ? DRIFT_GROUP.WIDENED
        : undefined
      : GROUP_OF_ALERT[alert.kind];
  if (group === undefined) return [];
  const headline =
    alert === undefined ? `${change.name} is a new surface` : alert.headline;
  return [
    {
      group,
      name: change.name,
      ...(change.grantedBy === undefined ? {} : { file: change.grantedBy }),
      summary: `${headline}. ${beforeAndAfter(change)}`,
      detail: change.detail,
    },
  ];
}

function goneItem(change: EnvironmentChange): DriftItem {
  return {
    group: DRIFT_GROUP.SERVER_GONE,
    name: change.name,
    ...(change.grantedBy === undefined ? {} : { file: change.grantedBy }),
    summary: `the MCP server ${change.name} is gone. before: configured; after: absent`,
  };
}

/** A count that moved already says both ends, and anything else was absent before. */
function beforeAndAfter(change: EnvironmentChange): string {
  const moved = change.detail.includes(MOVED_TO)
    ? change.detail
    : `before: absent; after: ${change.detail}`;
  return change.cause === undefined ? moved : `${moved}, as the agent ${change.cause}`;
}

/** Each item as the ledger row that keeps it. Noticed rather than done, so it is a read. */
export function driftRecords(items: readonly DriftItem[]): ConfigRecord[] {
  return items.map((item) => ({
    operation: `${DRIFT_OPERATION_PREFIX}${item.group}`,
    ...(item.agent === undefined ? {} : { agent: item.agent }),
    ...(item.file === undefined ? {} : { file: item.file }),
    summary: item.summary,
    class: TOOL_CLASS.READ,
    rule: CONFIG_RULE.DRIFT,
  }));
}

/** One notice per kind of change, and never more than a glance's worth in one pass. */
export function driftNotices(items: readonly DriftItem[]): string[] {
  const groups = new Map<DriftGroup, DriftItem[]>();
  for (const item of items)
    groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
  const notices = [...groups].map(([group, grouped]) => noticeFor(group, grouped));
  if (notices.length <= MOST_NOTICES_PER_PASS) return notices;
  const shown = notices.slice(0, MOST_NOTICES_PER_PASS - 1);
  const rest = notices.length - shown.length;
  return [
    ...shown,
    `${rest} other kinds of change arrived as well. "memnox timeline --since 1h" lists them.`,
  ];
}

function noticeFor(group: DriftGroup, items: readonly DriftItem[]): string {
  const first = items[0] as DriftItem;
  const names = namesOf(items);
  switch (group) {
    case DRIFT_GROUP.CREDENTIAL:
      return `${names} newly reachable by an agent here. "memnox explain ${first.name}" says which.`;
    case DRIFT_GROUP.NEW_SERVER:
      return `New MCP server: ${names}${countsOf(items)}. "memnox scan --mcp ${first.name}" shows what it brings.`;
    case DRIFT_GROUP.AUTHORITY:
      return items.length === 1
        ? `${first.summary.split('. before:')[0] ?? first.summary}. "memnox explain ${first.name}" shows what it may do now.`
        : `Authority grew for ${names}. "memnox timeline --since 1h" shows what moved.`;
    case DRIFT_GROUP.SERVER_GONE:
      return `MCP server gone: ${names}. An agent that relied on it will now fail. "memnox doctor" checks what is left.`;
    case DRIFT_GROUP.NEW_WRITE_TOOL:
      return `${names} can now change something outside this machine. "memnox protect" puts a rule in front.`;
    case DRIFT_GROUP.SELF_UPDATE:
      return `${names} updated itself, and nobody granted the difference. "memnox explain ${first.name}" shows its reach.`;
    case DRIFT_GROUP.DEFINITION:
      return `New skill or agent definition: ${names}. "memnox skills" reviews it.`;
    case DRIFT_GROUP.WIDENED:
      return `${names} reaches more than it did. "memnox timeline --since 1h" shows what moved.`;
  }
}

/** What one new server brings, where the scan already knew its tools. */
function countsOf(items: readonly DriftItem[]): string {
  const detail = items.length === 1 ? items[0]?.detail : undefined;
  return detail === undefined || detail === '' || detail.startsWith('0 ')
    ? ''
    : ` (${detail})`;
}

/** "a, b, c and 2 more", which is as many as a notice can carry and still be read. */
function namesOf(items: readonly DriftItem[]): string {
  const names = [...new Set(items.map((item) => item.name))];
  const shown = names.slice(0, NAMES_PER_NOTICE).join(', ');
  const more = names.length - NAMES_PER_NOTICE;
  return more > 0 ? `${shown} and ${more} more` : shown;
}
