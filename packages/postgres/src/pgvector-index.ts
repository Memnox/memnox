import type { VectorEntry, VectorIndex, VectorMatch } from '@memnox/memory';
import type { SqlClient } from './sql-client';

export const DECISION_EMBEDDINGS_TABLE = 'decision_embeddings';
/** text-embedding-3-small; the column type fixes this, so it is stored per index. */
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;
/** Favours recall over build time at decision-memory sizes. */
const HNSW_M = 16;
const HNSW_EF_CONSTRUCTION = 64;

/** Cosine distance against an HNSW index, so a query reads neighbours, not every row. */
export class PgVectorIndex implements VectorIndex {
  constructor(
    private readonly sql: SqlClient,
    private readonly dimensions: number = DEFAULT_EMBEDDING_DIMENSIONS,
    private readonly table: string = DECISION_EMBEDDINGS_TABLE,
  ) {}

  async upsert(entries: readonly VectorEntry[]): Promise<void> {
    for (const entry of entries) {
      if (entry.vector.length !== this.dimensions) continue;
      await this.sql.query(
        `INSERT INTO ${this.table} (id, embedding)
         VALUES ($1, $2::vector)
         ON CONFLICT (id) DO UPDATE SET embedding = $2::vector`,
        [entry.id, toVectorLiteral(entry.vector)],
      );
    }
  }

  async query(vector: readonly number[], limit: number): Promise<VectorMatch[]> {
    if (vector.length !== this.dimensions) return [];
    const { rows } = await this.sql.query(
      `SELECT id, 1 - (embedding <=> $1::vector) AS similarity
       FROM ${this.table}
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [toVectorLiteral(vector), limit],
    );
    return rows
      .map((row) => ({
        id: String(row['id']),
        similarity: Number(row['similarity']),
      }))
      .filter((match) => Number.isFinite(match.similarity) && match.similarity > 0);
  }

  async remove(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      await this.sql.query(`DELETE FROM ${this.table} WHERE id = $1`, [id]);
    }
  }

  async indexed(): Promise<string[]> {
    const { rows } = await this.sql.query(`SELECT id FROM ${this.table}`, []);
    return rows.map((row) => String(row['id']));
  }
}

function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

/** A dimension change means the model changed, so vectors are re-embedded. */
export async function ensurePgVectorSchema(
  sql: SqlClient,
  dimensions: number = DEFAULT_EMBEDDING_DIMENSIONS,
  table: string = DECISION_EMBEDDINGS_TABLE,
): Promise<void> {
  await sql.query(`CREATE EXTENSION IF NOT EXISTS vector`, []);
  const existing = await currentDimensions(sql, table);
  if (existing !== undefined && existing !== dimensions) {
    await sql.query(`DROP TABLE ${table}`, []);
  }
  await sql.query(
    `CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY,
      embedding vector(${dimensions}) NOT NULL
    )`,
    [],
  );
  await sql.query(
    `CREATE INDEX IF NOT EXISTS ${table}_hnsw
     ON ${table} USING hnsw (embedding vector_cosine_ops)
     WITH (m = ${HNSW_M}, ef_construction = ${HNSW_EF_CONSTRUCTION})`,
    [],
  );
}

async function currentDimensions(
  sql: SqlClient,
  table: string,
): Promise<number | undefined> {
  const { rows } = await sql.query(
    `SELECT a.atttypmod AS dimensions
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relname = $1 AND a.attname = 'embedding'`,
    [table],
  );
  const first = rows[0];
  if (first === undefined) return undefined;
  const dimensions = Number(first['dimensions']);
  return Number.isFinite(dimensions) && dimensions > 0 ? dimensions : undefined;
}
