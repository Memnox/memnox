import {
  PLAIN_TEXT_CODEC,
  type AgentIdentity,
  type IdentityStore,
  type TextCodec,
} from '@memnox/core';
import type { SqlClient, SqlRow } from './sql-client';

export class PostgresIdentityStore implements IdentityStore {
  constructor(
    private readonly sql: SqlClient,
    private readonly codec: TextCodec = PLAIN_TEXT_CODEC,
  ) {}

  async save(agent: AgentIdentity): Promise<void> {
    await this.sql.query(
      `INSERT INTO agents (id, token_hash, created_at, org_id, record)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET token_hash = $2, org_id = $4, record = $5`,
      [
        agent.id,
        agent.tokenHash,
        agent.createdAt,
        agent.orgId ?? null,
        this.encode(agent),
      ],
    );
  }

  async findById(id: string): Promise<AgentIdentity | null> {
    const { rows } = await this.sql.query(`SELECT record FROM agents WHERE id = $1`, [
      id,
    ]);
    return this.first(rows);
  }

  async findByTokenHash(tokenHash: string): Promise<AgentIdentity | null> {
    const { rows } = await this.sql.query(
      `SELECT record FROM agents WHERE token_hash = $1`,
      [tokenHash],
    );
    return this.first(rows);
  }

  async list(): Promise<AgentIdentity[]> {
    const { rows } = await this.sql.query(
      `SELECT record FROM agents ORDER BY created_at`,
    );
    return rows.map((row) => this.decode(row));
  }

  private first(rows: SqlRow[]): AgentIdentity | null {
    return rows.length > 0 ? this.decode(rows[0] as SqlRow) : null;
  }

  private encode(agent: AgentIdentity): string {
    return this.codec.encode(JSON.stringify(agent));
  }

  private decode(row: SqlRow): AgentIdentity {
    return JSON.parse(this.codec.decode(row['record'] as string)) as AgentIdentity;
  }
}
