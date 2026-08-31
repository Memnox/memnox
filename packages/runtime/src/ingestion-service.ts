import type { Logger } from '@memnox/core';
import {
  MAX_DOCUMENTS_PER_RUN,
  guardRegion,
  guardWrite,
  hashContent,
  isDue,
  isReadable,
  isUnchanged,
  newRawDocument,
  type RawDocument,
  type RawDocumentStore,
  type Source,
  type SourceStore,
  type Tenant,
  type TenantStore,
} from '@memnox/org-graph';

/** One page of whatever a system holds, in that system's own terms. */
export interface SourceRecord {
  externalId: string;
  kind: string;
  content: string;
  url?: string;
  author?: string;
  createdAt?: string;
}

/**
 * What every connector implements. Paging and rate limits belong here; nothing above
 * this line knows whether a source is a chat, a repository or a wiki.
 */
export interface Connector {
  readonly kind: string;
  /**
   * Records from one named part of the system, since a timestamp. Never throws for an
   * empty part: nothing there is an answer, not a failure.
   */
  read(part: string, since: string | undefined): Promise<SourceRecord[]>;
}

export interface IngestionResult {
  sourceId: string;
  read: number;
  /** Documents whose bytes changed, and are therefore worth re-extracting. */
  changed: number;
  parts: string[];
  error?: string;
}

export interface IngestionDeps {
  sources: SourceStore;
  raw: RawDocumentStore;
  tenants: TenantStore;
  /** One per source kind. A kind with no connector is a source nobody can read. */
  connectors: ReadonlyMap<string, Connector>;
  logger: Logger;
  /** Where this process runs, so a dedicated tenant's region can be enforced. */
  region: string;
  clock?: () => Date;
}

export const INGESTION_REFUSAL = {
  NO_CONNECTOR: 'no connector is registered for that kind of source',
  NOT_READABLE: 'that source is disconnected, paused, or reads nothing',
  UNKNOWN_TENANT: 'that workspace has no tenant record',
} as const;

/**
 * Continuously, not on import. A connector pages a source and writes raw documents with
 * their external ids; raw is kept, because an extractor improves and yesterday's pass
 * must be redoable against the same input.
 */
export class IngestionService {
  private readonly clock: () => Date;

  constructor(private readonly deps: IngestionDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  /** Every source of every kind that is due. A workspace connects many places. */
  async refreshWorkspace(workspaceId: string): Promise<IngestionResult[]> {
    const sources = await this.deps.sources.listByWorkspace(workspaceId);
    const now = this.clock();
    const results: IngestionResult[] = [];
    for (const source of sources) {
      if (!isDue(source, now)) continue;
      results.push(await this.refresh(source));
    }
    return results;
  }

  async refresh(source: Source): Promise<IngestionResult> {
    const empty = { sourceId: source.id, read: 0, changed: 0, parts: [] };
    if (!isReadable(source)) {
      return { ...empty, error: INGESTION_REFUSAL.NOT_READABLE };
    }

    const tenant = await this.deps.tenants.findByWorkspace(source.workspaceId);
    if (tenant === null) return { ...empty, error: INGESTION_REFUSAL.UNKNOWN_TENANT };
    // A dedicated tenant's raw documents do not leave the region it was pinned to.
    const inRegion = guardRegion(tenant, this.deps.region);
    if (!inRegion.ok) return { ...empty, error: inRegion.reason };

    const connector = this.deps.connectors.get(source.kind);
    if (connector === undefined) {
      return { ...empty, error: INGESTION_REFUSAL.NO_CONNECTOR };
    }

    let read = 0;
    let changed = 0;
    const parts: string[] = [];
    for (const part of source.scope.include) {
      if (source.scope.exclude !== undefined && source.scope.exclude.includes(part)) {
        continue;
      }
      try {
        const records = await connector.read(part, source.lastReadAt);
        parts.push(part);
        for (const record of records.slice(0, MAX_DOCUMENTS_PER_RUN)) {
          read += 1;
          if (await this.store(source, tenant, record)) changed += 1;
        }
      } catch (err) {
        /* One unreadable part must not lose the parts that did read. The failure is
           recorded on the source, so a silent source is distinguishable from a quiet one. */
        const reason = String(err);
        this.deps.logger.error(`source ${source.id} part "${part}" failed: ${reason}`);
        await this.deps.sources.save({
          ...source,
          lastError: reason,
          lastReadAt: this.clock().toISOString(),
        });
        return { sourceId: source.id, read, changed, parts, error: reason };
      }
    }

    const { lastError: _lastError, ...cleared } = source;
    await this.deps.sources.save({
      ...cleared,
      lastReadAt: this.clock().toISOString(),
    });
    return { sourceId: source.id, read, changed, parts };
  }

  /** True when the bytes changed, which is the only reason to extract again. */
  private async store(
    source: Source,
    tenant: Tenant,
    record: SourceRecord,
  ): Promise<boolean> {
    const document: RawDocument = newRawDocument({
      sourceId: source.id,
      workspaceId: source.workspaceId,
      externalId: record.externalId,
      kind: record.kind,
      content: record.content,
      fetchedAt: this.clock().toISOString(),
      ...(record.url === undefined ? {} : { url: record.url }),
      ...(record.author === undefined ? {} : { author: record.author }),
      ...(record.createdAt === undefined ? {} : { createdAt: record.createdAt }),
    });

    // Refused rather than filtered: a write into another workspace is a bug, not a miss.
    const guard = guardWrite(tenant, document);
    if (!guard.ok) {
      this.deps.logger.error(`refused a cross-tenant write from source ${source.id}`);
      return false;
    }

    const existing = await this.deps.raw.findByExternalId(source.id, record.externalId);
    if (isUnchanged(existing, document)) return false;
    await this.deps.raw.put(document);
    return true;
  }

  /** What was read is removable: forgetting a source forgets what it wrote. */
  async forget(sourceId: string): Promise<number> {
    return this.deps.raw.deleteBySource(sourceId);
  }
}

export { hashContent };
