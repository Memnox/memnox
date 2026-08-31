import {
  DEFAULT_REFRESH_MINUTES,
  SOURCE_STATUS,
  type SourceKind,
  type SourceStatus,
} from './source.constants';

/**
 * Scoped from the start. A workspace reads named parts of a system, chosen from what
 * that system says it holds — never "everything", which is a decision nobody made.
 */
export interface SourceScope {
  /** Channels, repositories, spaces, folders — named in the source's own terms. */
  include: string[];
  /** Named exclusions inside an included part, so one private channel can be left out. */
  exclude?: string[];
}

export interface Source {
  id: string;
  workspaceId: string;
  kind: SourceKind;
  /** What a person calls it: "acme/checkout", "#eng-decisions". */
  displayName: string;
  /** The account or installation this reads through, so a revocation is traceable. */
  externalAccountId?: string;
  scope: SourceScope;
  status: SourceStatus;
  connectedAt: string;
  lastReadAt?: string;
  /** Why the last run failed, kept so a silent source is distinguishable from a quiet one. */
  lastError?: string;
  refreshMinutes: number;
  /** Set when access was lost or paused. The scope above survives it. */
  inactiveSince?: string;
}

export interface SourceStore {
  save(source: Source): Promise<void>;
  findById(id: string): Promise<Source | null>;
  listByWorkspace(workspaceId: string): Promise<Source[]>;
}

export function newSource(
  input: Omit<Source, 'status' | 'refreshMinutes'> & {
    status?: SourceStatus;
    refreshMinutes?: number;
  },
): Source {
  return {
    ...input,
    status: input.status ?? SOURCE_STATUS.CONNECTED,
    refreshMinutes: input.refreshMinutes ?? DEFAULT_REFRESH_MINUTES,
  };
}

/**
 * A source outlives its connection. Losing access stops the reading and keeps
 * everything somebody chose, so reconnecting is not re-choosing.
 */
export function disconnect(source: Source, at: string, reason?: string): Source {
  return {
    ...source,
    status: SOURCE_STATUS.DISCONNECTED,
    inactiveSince: at,
    ...(reason === undefined ? {} : { lastError: reason }),
  };
}

export function pause(source: Source, at: string): Source {
  return { ...source, status: SOURCE_STATUS.PAUSED, inactiveSince: at };
}

/** Reconnecting restores the scope that was already chosen; nothing is re-picked. */
export function reconnect(source: Source): Source {
  const { inactiveSince: _inactiveSince, lastError: _lastError, ...rest } = source;
  return { ...rest, status: SOURCE_STATUS.CONNECTED };
}

export function isReadable(source: Source): boolean {
  return source.status === SOURCE_STATUS.CONNECTED && source.scope.include.length > 0;
}

/** Continuously, not on import: due when the refresh window has passed. */
export function isDue(source: Source, now: Date): boolean {
  if (!isReadable(source)) return false;
  if (source.lastReadAt === undefined) return true;
  const elapsed = now.getTime() - Date.parse(source.lastReadAt);
  return elapsed >= source.refreshMinutes * 60 * 1000;
}

/** Whether a named part of the system is inside what this workspace chose to read. */
export function covers(source: Source, part: string): boolean {
  if (source.scope.exclude !== undefined && source.scope.exclude.includes(part)) {
    return false;
  }
  return source.scope.include.includes(part);
}

/** What was read is visible, and removable. */
export interface SourceSummary {
  id: string;
  kind: SourceKind;
  displayName: string;
  status: SourceStatus;
  reads: string[];
  lastReadAt?: string;
}

export function summarize(source: Source): SourceSummary {
  return {
    id: source.id,
    kind: source.kind,
    displayName: source.displayName,
    status: source.status,
    reads: [...source.scope.include],
    ...(source.lastReadAt === undefined ? {} : { lastReadAt: source.lastReadAt }),
  };
}
