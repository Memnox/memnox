import type { SqlClient } from './sql-client';

interface TableSchema {
  name: string;
  create: string;
  /** Additive `ADD COLUMN IF NOT EXISTS` statements — how existing tables migrate. */
  columns?: string[];
  indexes: string[];
  /** `DROP INDEX IF EXISTS` for indexes nothing queries any more. Never drops data. */
  droppedIndexes?: string[];
}

/** Query fields are columns, the record a codec blob: searches never touch ciphertext. */
const RUNTIME_TABLES: TableSchema[] = [
  {
    name: 'agents',
    create: `CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      org_id TEXT,
      record TEXT NOT NULL
    )`,
    columns: [`ALTER TABLE agents ADD COLUMN IF NOT EXISTS org_id TEXT`],
    indexes: [`CREATE INDEX IF NOT EXISTS agents_token_hash ON agents (token_hash)`],
    droppedIndexes: [`DROP INDEX IF EXISTS agents_org`],
  },
  {
    name: 'decisions',
    create: `CREATE TABLE decisions (
      id TEXT PRIMARY KEY,
      decided_at TEXT NOT NULL,
      org_id TEXT,
      record TEXT NOT NULL
    )`,
    columns: [`ALTER TABLE decisions ADD COLUMN IF NOT EXISTS org_id TEXT`],
    indexes: [
      `CREATE INDEX IF NOT EXISTS decisions_decided_at ON decisions (decided_at)`,
    ],
    droppedIndexes: [`DROP INDEX IF EXISTS decisions_org_decided_at`],
  },
  {
    name: 'decision_vectors',
    create: `CREATE TABLE decision_vectors (
      id TEXT PRIMARY KEY,
      vector TEXT NOT NULL
    )`,
    indexes: [],
  },
  {
    name: 'approvals',
    create: `CREATE TABLE approvals (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      org_id TEXT,
      record TEXT NOT NULL
    )`,
    columns: [`ALTER TABLE approvals ADD COLUMN IF NOT EXISTS org_id TEXT`],
    indexes: [
      `CREATE INDEX IF NOT EXISTS approvals_pending ON approvals (status, fingerprint)`,
      `CREATE INDEX IF NOT EXISTS approvals_status_created_at ON approvals (status, created_at)`,
    ],
    droppedIndexes: [`DROP INDEX IF EXISTS approvals_org`],
  },
  {
    name: 'audit_events',
    // seq breaks the tie: ISO timestamps collide inside a millisecond.
    create: `CREATE TABLE audit_events (
      id TEXT PRIMARY KEY,
      seq BIGSERIAL,
      occurred_at TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      session_id TEXT,
      org_id TEXT,
      project_id TEXT,
      record TEXT NOT NULL
    )`,
    columns: [
      `ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS org_id TEXT`,
      `ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS project_id TEXT`,
      `ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS seq BIGSERIAL`,
    ],
    indexes: [
      `CREATE INDEX IF NOT EXISTS audit_events_occurred_at ON audit_events (occurred_at)`,
      `CREATE INDEX IF NOT EXISTS audit_events_agent ON audit_events (agent_id)`,
      `CREATE INDEX IF NOT EXISTS audit_events_agent_time ON audit_events (agent_id, occurred_at DESC)`,
      `CREATE INDEX IF NOT EXISTS audit_events_session_time ON audit_events (session_id, occurred_at DESC)`,
      `CREATE INDEX IF NOT EXISTS audit_events_org_time ON audit_events (org_id, occurred_at DESC)`,
      `CREATE INDEX IF NOT EXISTS audit_events_project_time ON audit_events (project_id, occurred_at DESC)`,
    ],
  },
];

/** Idempotent bootstrap: tables, additive columns, and indexes are created only when missing. */
export async function ensureRuntimeSchema(sql: SqlClient): Promise<void> {
  await ensureTables(sql, RUNTIME_TABLES);
}

export async function ensureTables(sql: SqlClient, tables: TableSchema[]): Promise<void> {
  const { rows } = await sql.query(`SELECT table_name FROM information_schema.tables`);
  const existing = new Set(rows.map((row) => String(row['table_name'])));
  for (const table of tables) {
    if (!existing.has(table.name)) await sql.query(table.create);
    for (const column of table.columns ?? []) {
      await sql.query(column);
    }
    for (const index of table.indexes) {
      await sql.query(index);
    }
    for (const dropped of table.droppedIndexes ?? []) {
      await sql.query(dropped);
    }
  }
}

export type { TableSchema };
