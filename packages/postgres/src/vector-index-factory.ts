import type { VectorIndex } from '@memnox/memory';
import { PostgresVectorIndex } from './postgres-vector-index';
import {
  DECISION_EMBEDDINGS_TABLE,
  DEFAULT_EMBEDDING_DIMENSIONS,
  PgVectorIndex,
  ensurePgVectorSchema,
} from './pgvector-index';
import type { SqlClient } from './sql-client';

export interface VectorIndexOptions {
  dimensions?: number;
  /** Lets a second corpus (source events) reuse this index on its own table. */
  table?: string;
  logger?: { warn(message: string): void };
}

/** pgvector when installable, JSON scan otherwise — slow search beats none. */
export async function createPostgresVectorIndex(
  sql: SqlClient,
  options: VectorIndexOptions = {},
): Promise<VectorIndex> {
  const dimensions = options.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
  const table = options.table ?? DECISION_EMBEDDINGS_TABLE;
  try {
    await ensurePgVectorSchema(sql, dimensions, table);
    return new PgVectorIndex(sql, dimensions, table);
  } catch (error) {
    if (options.logger !== undefined) {
      options.logger.warn(
        `pgvector unavailable, falling back to scanned vector search: ${String(error)}`,
      );
    }
    return new PostgresVectorIndex(sql);
  }
}
