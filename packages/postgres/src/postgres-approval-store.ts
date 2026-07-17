import {
  APPROVAL_STATUS,
  PLAIN_TEXT_CODEC,
  type Approval,
  type ApprovalStatus,
  type ApprovalStore,
  type TextCodec,
} from '@memnox/core';
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

  async listByStatus(status: ApprovalStatus): Promise<Approval[]> {
    const { rows } = await this.sql.query(
      `SELECT record FROM approvals WHERE status = $1 ORDER BY created_at`,
      [status],
    );
    return rows.map((row) => this.decode(row));
  }

  private encode(approval: Approval): string {
    return this.codec.encode(JSON.stringify(approval));
  }

  private decode(row: SqlRow): Approval {
    return JSON.parse(this.codec.decode(row['record'] as string)) as Approval;
  }
}
