import { describe, expect, it } from 'vitest';
import type { SqlRow } from '../src/sql-client';
import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  PgVectorIndex,
  ensurePgVectorSchema,
} from '../src/pgvector-index';
import { createPostgresVectorIndex } from '../src/vector-index-factory';
import { PostgresVectorIndex } from '../src/postgres-vector-index';

interface Executed {
  text: string;
  params: unknown[];
}

/** Records SQL and replays queued results, so the shape sent to pg is assertable. */
class RecordingSql {
  readonly executed: Executed[] = [];
  private readonly results: SqlRow[][] = [];

  queue(rows: SqlRow[]): void {
    this.results.push(rows);
  }

  async query(text: string, params: unknown[] = []): Promise<{ rows: SqlRow[] }> {
    this.executed.push({ text, params });
    return { rows: this.results.shift() ?? [] };
  }

  async end(): Promise<void> {}

  find(fragment: string): Executed | undefined {
    return this.executed.find((entry) => entry.text.includes(fragment));
  }
}

class FailingSql {
  async query(): Promise<{ rows: SqlRow[] }> {
    throw new Error('extension "vector" is not available');
  }
  async end(): Promise<void> {}
}

const vector = (fill: number): number[] =>
  Array.from({ length: DEFAULT_EMBEDDING_DIMENSIONS }, () => fill);

describe('PgVectorIndex', () => {
  it('scores with cosine distance inside Postgres, not in process', async () => {
    const sql = new RecordingSql();
    sql.queue([{ id: 'd1', similarity: 0.91 }]);

    const matches = await new PgVectorIndex(sql).query(vector(0.1), 5);

    const query = sql.find('SELECT id');
    expect(query).toBeDefined();
    expect(query?.text).toContain('1 - (embedding <=> $1::vector)');
    expect(query?.text).toContain('ORDER BY embedding <=> $1::vector');
    // The LIMIT must reach the database, or the ANN index buys nothing.
    expect(query?.text).toContain('LIMIT $2');
    expect(query?.params[1]).toBe(5);
    expect(matches).toEqual([{ id: 'd1', similarity: 0.91 }]);
  });

  it('sends the vector as a pgvector literal', async () => {
    const sql = new RecordingSql();
    await new PgVectorIndex(sql, 3).upsert([{ id: 'd1', vector: [1, 0.5, -2] }]);

    expect(sql.find('INSERT INTO')?.params[1]).toBe('[1,0.5,-2]');
  });

  // A wrong-sized vector means the model changed; pg would reject it anyway.
  it('ignores vectors that do not match the column width', async () => {
    const sql = new RecordingSql();
    const index = new PgVectorIndex(sql, 3);

    await index.upsert([{ id: 'd1', vector: [1, 2] }]);
    expect(sql.find('INSERT INTO')).toBeUndefined();
    expect(await index.query([1, 2], 5)).toEqual([]);
  });

  it('drops non-positive similarities so unrelated rows never rank', async () => {
    const sql = new RecordingSql();
    sql.queue([
      { id: 'near', similarity: 0.8 },
      { id: 'opposite', similarity: -0.3 },
      { id: 'orthogonal', similarity: 0 },
    ]);

    const matches = await new PgVectorIndex(sql, 3).query([1, 0, 0], 10);

    expect(matches.map((match) => match.id)).toEqual(['near']);
  });

  it('builds the extension, table and an ANN index', async () => {
    const sql = new RecordingSql();
    await ensurePgVectorSchema(sql, 1536);

    expect(sql.find('CREATE EXTENSION')?.text).toContain('vector');
    expect(sql.find('CREATE TABLE')?.text).toContain('vector(1536)');
    expect(sql.find('CREATE INDEX')?.text).toContain('hnsw');
    expect(sql.find('CREATE INDEX')?.text).toContain('vector_cosine_ops');
  });

  // Vectors are re-embedded from the decisions they came from, so a rebuild is safe.
  it('rebuilds the table when the model changes its output size', async () => {
    const sql = new RecordingSql();
    sql.queue([]); // CREATE EXTENSION
    sql.queue([{ dimensions: 768 }]); // existing column width

    await ensurePgVectorSchema(sql, 1536);

    expect(sql.find('DROP TABLE')).toBeDefined();
    expect(sql.find('CREATE TABLE')?.text).toContain('vector(1536)');
  });

  it('keeps the table when the width already agrees', async () => {
    const sql = new RecordingSql();
    sql.queue([]);
    sql.queue([{ dimensions: 1536 }]);

    await ensurePgVectorSchema(sql, 1536);

    expect(sql.find('DROP TABLE')).toBeUndefined();
  });
});

describe('createPostgresVectorIndex', () => {
  it('uses pgvector when the extension installs', async () => {
    const index = await createPostgresVectorIndex(new RecordingSql());

    expect(index).toBeInstanceOf(PgVectorIndex);
  });

  // Search working slowly beats search not working at all.
  it('falls back to the scanned index and says why', async () => {
    const warnings: string[] = [];
    const index = await createPostgresVectorIndex(new FailingSql(), {
      logger: { warn: (message) => warnings.push(message) },
    });

    expect(index).toBeInstanceOf(PostgresVectorIndex);
    expect(warnings[0]).toContain('pgvector unavailable');
  });
});
