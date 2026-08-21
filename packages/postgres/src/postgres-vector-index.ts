import type { VectorEntry, VectorIndex, VectorMatch } from '@memnox/memory';
import { cosineSimilarity } from '@memnox/memory';
import type { SqlClient } from './sql-client';

/** JSON vectors scored in process; pgvector is the swap when the corpus grows. */
export class PostgresVectorIndex implements VectorIndex {
  constructor(private readonly sql: SqlClient) {}

  async upsert(entries: readonly VectorEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.sql.query(
        `INSERT INTO decision_vectors (id, vector)
         VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET vector = $2`,
        [entry.id, JSON.stringify(entry.vector)],
      );
    }
  }

  async query(vector: readonly number[], limit: number): Promise<VectorMatch[]> {
    const { rows } = await this.sql.query(`SELECT id, vector FROM decision_vectors`, []);
    return rows
      .map((row) => ({
        id: String(row['id']),
        similarity: cosineSimilarity(vector, decodeVector(row['vector'])),
      }))
      .filter((match) => match.similarity > 0)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  async remove(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      await this.sql.query(`DELETE FROM decision_vectors WHERE id = $1`, [id]);
    }
  }

  async indexed(): Promise<string[]> {
    const { rows } = await this.sql.query(`SELECT id FROM decision_vectors`, []);
    return rows.map((row) => String(row['id']));
  }
}

function decodeVector(raw: unknown): number[] {
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    return Array.isArray(parsed) ? (parsed as number[]) : [];
  } catch {
    return []; // A corrupt row scores zero rather than breaking the search.
  }
}
