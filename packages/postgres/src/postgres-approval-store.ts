import {
  APPROVAL_STATUS,
  isUnspentGrant,
  PLAIN_TEXT_CODEC,
  type Approval,
  type ApprovalStatus,
  type ApprovalStore,
  type TextCodec,
} from '@memnox/core';
import { PRUNE_BATCH_SIZE, PRUNE_MAX_BATCHES } from './prune.constants';
import type { SqlClient, SqlRow } from './sql-client';

export class PostgresApprovalStore implements ApprovalStore {
  constructor(
    private readonly sql: SqlClient,
    private readonly codec: TextCodec = PLAIN_TEXT_CODEC,
  ) {}

  async save(approval: Approval): Promise<void> {
    await this.sql.query(
      `INSERT INTO approvals (id, fingerprint, status, created_at, org_id, record)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET status = $3, org_id = $5, record = $6`,
      [
        approval.id,
        approval.requestFingerprint,
        approval.status,
        approval.createdAt,
        approval.orgId ?? null,
        this.encode(approval),
      ],
    );
  }

  async findById(id: string): Promise<Approval | null> {
    const { rows } = await this.sql.query(`SELECT record FROM approvals WHERE id = $1`, [
      id,
    ]);
    return rows.length > 0 ? this.decode(rows[0] as SqlRow) : null;
  }

  async findPendingByFingerprint(fingerprint: string): Promise<Approval | null> {
    const { rows } = await this.sql.query(
      `SELECT record FROM approvals
       WHERE status = $1 AND fingerprint = $2
       ORDER BY created_at DESC`,
      [APPROVAL_STATUS.PENDING, fingerprint],
    );
    return rows.length > 0 ? this.decode(rows[0] as SqlRow) : null;
  }

  /** Newest first: a re-raised grant supersedes an older one for the same action. */
  async findGrantedByFingerprint(fingerprint: string): Promise<Approval | null> {
    const { rows } = await this.sql.query(
      `SELECT record FROM approvals
       WHERE status = $1 AND fingerprint = $2
       ORDER BY created_at DESC`,
      [APPROVAL_STATUS.APPROVED, fingerprint],
    );
    for (const row of rows) {
      const approval = this.decode(row as SqlRow);
      // consumedAt lives inside the encrypted record, so it cannot be a WHERE clause.
      if (isUnspentGrant(approval, fingerprint)) return approval;
    }
    return null;
  }

  async listByStatus(status: ApprovalStatus): Promise<Approval[]> {
    const { rows } = await this.sql.query(
      `SELECT record FROM approvals WHERE status = $1 ORDER BY created_at`,
      [status],
    );
    return rows.map((row) => this.decode(row));
  }

  /** Pending rows are excluded in SQL: an unanswered hold is not ours to delete. */
  async pruneResolvedBefore(cutoff: string): Promise<number> {
    let removed = 0;
    for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch += 1) {
      const { rows } = await this.sql.query(
        `DELETE FROM approvals WHERE id IN (
           SELECT id FROM approvals
           WHERE status <> $1 AND created_at < $2
           ORDER BY created_at LIMIT $3
         ) RETURNING id`,
        [APPROVAL_STATUS.PENDING, cutoff, PRUNE_BATCH_SIZE],
      );
      removed += rows.length;
      if (rows.length < PRUNE_BATCH_SIZE) break;
    }
    return removed;
  }

  private encode(approval: Approval): string {
    return this.codec.encode(JSON.stringify(approval));
  }

  private decode(row: SqlRow): Approval {
    return JSON.parse(this.codec.decode(row['record'] as string)) as Approval;
  }
}
