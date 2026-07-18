import { PLAIN_TEXT_CODEC, type TextCodec } from '@memnox/core';
import type { DecisionRecord, DecisionStore } from '@memnox/memory';
import type { SqlClient, SqlRow } from './sql-client';

export class PostgresDecisionStore implements DecisionStore {
  constructor(
    private readonly sql: SqlClient,
    private readonly codec: TextCodec = PLAIN_TEXT_CODEC,
  ) {}

  async save(record: DecisionRecord): Promise<void> {
    await this.sql.query(
      `INSERT INTO decisions (id, decided_at, org_id, record)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET decided_at = $2, org_id = $3, record = $4`,
      [
        record.id,
        record.decidedAt,
        record.orgId ?? null,
        this.codec.encode(JSON.stringify(record)),
      ],
    );
  }

  async list(): Promise<DecisionRecord[]> {
    const { rows } = await this.sql.query(
      `SELECT record FROM decisions ORDER BY decided_at`,
    );
    return rows.map(
      (row: SqlRow) =>
        JSON.parse(this.codec.decode(row['record'] as string)) as DecisionRecord,
    );
  }

  async remove(id: string): Promise<boolean> {
    const { rows } = await this.sql.query(
      `DELETE FROM decisions WHERE id = $1 RETURNING id`,
      [id],
    );
    return rows.length > 0;
  }
}
