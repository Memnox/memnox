import {
  AuditChainVerifier,
  chainAuditEvent,
  GENESIS_HASH,
  PLAIN_TEXT_CODEC,
  type ActionEvent,
  type AuditChainVerification,
  type AuditLog,
  type AuditQuery,
  type TextCodec,
} from '@memnox/core';
import { PRUNE_BATCH_SIZE, PRUNE_MAX_BATCHES } from './prune.constants';
import type { SqlClient, SqlRow } from './sql-client';

/** Chain verification streams in pages instead of loading the whole log. */
const VERIFY_PAGE_SIZE = 1_000;

export class PostgresAuditLog implements AuditLog {
  constructor(
    private readonly sql: SqlClient,
    private readonly codec: TextCodec = PLAIN_TEXT_CODEC,
  ) {}

  async append(event: ActionEvent): Promise<void> {
    const linked = chainAuditEvent(event, await this.tipHash());
    await this.sql.query(
      `INSERT INTO audit_events (id, occurred_at, agent_id, session_id, org_id, project_id, record)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        linked.id,
        linked.occurredAt,
        linked.agentId,
        linked.sessionId ?? null,
        linked.orgId ?? null,
        linked.projectId ?? null,
        this.codec.encode(JSON.stringify(linked)),
      ],
    );
  }

  async recent(limit: number): Promise<ActionEvent[]> {
    const { rows } = await this.sql.query(
      `SELECT record FROM audit_events ORDER BY occurred_at DESC, seq DESC LIMIT $1`,
      [limit],
    );
    return rows.map((row) => this.decode(row));
  }

  async query(filter: AuditQuery): Promise<ActionEvent[]> {
    // ISO-8601 strings compare lexicographically = chronologically.
    const conditions: string[] = [];
    const params: unknown[] = [];
    const where = (column: string, value: unknown, operator = '='): void => {
      params.push(value);
      conditions.push(`${column} ${operator} $${params.length}`);
    };
    if (filter.eventId) where('id', filter.eventId);
    if (filter.agentId) where('agent_id', filter.agentId);
    if (filter.sessionId) where('session_id', filter.sessionId);
    if (filter.orgId) where('org_id', filter.orgId);
    if (filter.projectId) where('project_id', filter.projectId);
    if (filter.from) where('occurred_at', filter.from, '>=');
    if (filter.to) where('occurred_at', filter.to, '<=');
    const clause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // A bounded query takes the newest N in the database and flips them back to chronological order.
    if (filter.limit !== undefined) {
      params.push(filter.limit);
      const { rows } = await this.sql.query(
        `SELECT record FROM audit_events ${clause}
         ORDER BY occurred_at DESC, seq DESC LIMIT $${params.length}`,
        params,
      );
      return rows.map((row) => this.decode(row)).reverse();
    }
    const { rows } = await this.sql.query(
      `SELECT record FROM audit_events ${clause} ORDER BY occurred_at, seq`,
      params,
    );
    return rows.map((row) => this.decode(row));
  }

  /** Batched so a retention sweep never holds a table-wide lock on a hot audit table. */
  async pruneBefore(cutoff: string): Promise<number> {
    let removed = 0;
    for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch += 1) {
      const { rows } = await this.sql.query(
        `DELETE FROM audit_events WHERE id IN (
           SELECT id FROM audit_events WHERE occurred_at < $1 ORDER BY occurred_at LIMIT $2
         ) RETURNING id`,
        [cutoff, PRUNE_BATCH_SIZE],
      );
      removed += rows.length;
      if (rows.length < PRUNE_BATCH_SIZE) break;
    }
    return removed;
  }

  async verifyChain(): Promise<AuditChainVerification> {
    const verifier = new AuditChainVerifier();
    for (let offset = 0; ; offset += VERIFY_PAGE_SIZE) {
      const { rows } = await this.sql.query(
        `SELECT record FROM audit_events ORDER BY occurred_at, seq LIMIT $1 OFFSET $2`,
        [VERIFY_PAGE_SIZE, offset],
      );
      for (const row of rows) {
        if (!verifier.push(this.decode(row))) return verifier.result();
      }
      if (rows.length < VERIFY_PAGE_SIZE) break;
    }
    return verifier.result();
  }

  private async tipHash(): Promise<string> {
    const { rows } = await this.sql.query(
      `SELECT record FROM audit_events ORDER BY occurred_at DESC, seq DESC LIMIT 1`,
    );
    const tip = rows[0];
    return tip ? (this.decode(tip).hash ?? GENESIS_HASH) : GENESIS_HASH;
  }

  private decode(row: SqlRow): ActionEvent {
    return JSON.parse(this.codec.decode(row['record'] as string)) as ActionEvent;
  }
}
