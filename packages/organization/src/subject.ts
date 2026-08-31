/** One actor table. A person or a machine: they differ in how they authenticate, and in nothing else. */
export const SUBJECT_KIND = {
  HUMAN: 'human',
  AGENT: 'agent',
  SERVICE: 'service',
} as const;

export type SubjectKind = (typeof SUBJECT_KIND)[keyof typeof SUBJECT_KIND];

export const REGISTERED_VIA = {
  ENROLMENT: 'enrolment',
  PROVIDER: 'provider',
  PIPELINE: 'pipeline',
  VENDOR: 'vendor',
  CONSOLE: 'console',
} as const;

export type RegisteredVia = (typeof REGISTERED_VIA)[keyof typeof REGISTERED_VIA];

export interface Subject {
  id: string;
  orgId: string;
  kind: SubjectKind;
  displayName: string;
  /** Required for agents: every later escalation resolves through this edge. */
  ownerId?: string;
  publicKey?: string;
  environment?: string;
  registeredVia: RegisteredVia;

  /** The product: "claude-code". A rule about this governs a tool, not a job. */
  agentKind?: string;
  /**
   * The job: "release-engineer". Policy is written about the role, because a rule
   * about a product will be wrong the moment the company adopts another one.
   */
  roleId?: string;
  /** The person it acts for, and the reason an incident can name a human. */
  principalId?: string;
}

export interface AgentRole {
  id: string;
  orgId: string;
  name: string;
  purpose: string;
  ownerTeamId: string;
  expectedSurfaces: string[];
  expectedEnvironments: string[];
  /** Autonomy hangs here, not on the kind: the tool can be swapped underneath it. */
  autonomyLevel?: number;
}

/**
 * All three or it is not enrolled. An agent with a kind and no role and no principal is
 * exactly the unmanaged category the census counts.
 */
export function isEnrollable(subject: Subject): boolean {
  if (subject.kind !== SUBJECT_KIND.AGENT) return true;
  if (subject.agentKind === undefined) return false;
  if (subject.roleId === undefined) return false;
  if (subject.principalId === undefined) return false;
  return subject.ownerId !== undefined;
}

export const OWNER_STATUS = {
  NAMED: 'named',
  INFERRED: 'inferred',
  UNKNOWN: 'unknown',
} as const;

export type OwnerStatus = (typeof OWNER_STATUS)[keyof typeof OWNER_STATUS];

export interface CensusEntry {
  /** Absent while unmanaged: an entry exists before a subject does. */
  subjectId?: string;
  source: Exclude<RegisteredVia, 'console'>;
  /** The record that proved it exists. A number a lead cannot drill into is not repeated. */
  evidence: string;
  reach: { production: boolean; customerData: boolean; destructive: boolean };
  /**
   * A field, not a filter, or the dashboard quietly reports only the agents that were
   * easy. Naming the ungovernable is more valuable than pretending otherwise.
   */
  governable: boolean;
  ownerStatus: OwnerStatus;
  firstSeen: string;
}

export interface CensusSummary {
  total: number;
  bySource: Record<string, number>;
  noNamedOwner: number;
  reachProduction: number;
  reachCustomerData: number;
  destructive: number;
  ungovernable: number;
}

/** The gap between what they thought and what is there is the finding, and it is theirs. */
export function summarizeCensus(entries: readonly CensusEntry[]): CensusSummary {
  const bySource: Record<string, number> = {};
  let noNamedOwner = 0;
  let reachProduction = 0;
  let reachCustomerData = 0;
  let destructive = 0;
  let ungovernable = 0;

  for (const entry of entries) {
    bySource[entry.source] = (bySource[entry.source] ?? 0) + 1;
    if (entry.ownerStatus !== OWNER_STATUS.NAMED) noNamedOwner += 1;
    if (entry.reach.production) reachProduction += 1;
    if (entry.reach.customerData) reachCustomerData += 1;
    if (entry.reach.destructive) destructive += 1;
    if (!entry.governable) ungovernable += 1;
  }

  return {
    total: entries.length,
    bySource,
    noNamedOwner,
    reachProduction,
    reachCustomerData,
    destructive,
    ungovernable,
  };
}

export const SUPPLY_CHAIN_EVENT_KIND = {
  MCP_SERVER_ADDED: 'mcp_server_added',
  VENDOR_CHANGED: 'vendor_changed',
  CAPABILITY_WIDENED: 'capability_widened',
} as const;

export type SupplyChainEventKind =
  (typeof SUPPLY_CHAIN_EVENT_KIND)[keyof typeof SUPPLY_CHAIN_EVENT_KIND];

/** A new MCP server is a supply chain event, and a vendor changing its agent is the same one. */
export interface SupplyChainEvent {
  id: string;
  kind: SupplyChainEventKind;
  target: string;
  publisher?: string;
  requestedCapabilities?: string[];
  priorState?: string;
  newState: string;
  cause: string;
  /** Held pending a person, not blocked forever. */
  review: 'pending' | 'approved' | 'rejected';
}

export interface Install {
  id: string;
  orgId: string;
  subjectIds: string[];
  hostLabel: string;
  runtimeVersion: string;
  seams: { kind: string; mode: string; blindTo: string[] }[];
  policyBundleVersion: string;
  lastSeenAt: string;
}

/** One laptop with the proxy off is the story, not the thirty-nine with it on. */
export function installDrift(installs: readonly Install[]): Install[] {
  const versions = installs.map((install) => install.policyBundleVersion);
  const commonest = mode(versions);
  return installs.filter((install) => install.policyBundleVersion !== commonest);
}

function mode(values: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: string | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}
