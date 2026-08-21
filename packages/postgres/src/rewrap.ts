import type { SqlClient, SqlRow } from './sql-client';

/** Every runtime table that stores an encrypted blob in a `record` column. */
export const REWRAPPABLE_TABLES: readonly string[] = [
  'agents',
  'decisions',
  'approvals',
  'audit_events',
];

/** Bounded so a rewrap of a large audit log never holds the whole table in memory. */
const REWRAP_BATCH_SIZE = 500;
/** Rows carrying no envelope are counted under this key so they stay visible. */
export const PLAINTEXT_KEY_ID = '(plaintext)';

interface RecordRow {
  id: string;
  record: string;
}

export interface TableKeyUsage {
  table: string;
  byKeyId: Record<string, number>;
}

/** Plaintext never changes, so the audit chain stays valid; null from `recode` skips. */
export async function rewrapTable(
  sql: SqlClient,
  table: string,
  recode: (stored: string) => string | null,
  batchSize: number = REWRAP_BATCH_SIZE,
): Promise<number> {
  let rewrapped = 0;
  await eachRecordRow(sql, table, batchSize, async (row) => {
    const next = recode(row.record);
    if (next === null) return;
    await sql.query(`UPDATE ${table} SET record = $1 WHERE id = $2`, [next, row.id]);
    rewrapped += 1;
  });
  return rewrapped;
}

/** What a rewrap would touch, without touching it. */
export async function tableKeyUsage(
  sql: SqlClient,
  table: string,
  keyIdOf: (stored: string) => string | null,
  batchSize: number = REWRAP_BATCH_SIZE,
): Promise<TableKeyUsage> {
  const byKeyId: Record<string, number> = {};
  await eachRecordRow(sql, table, batchSize, async (row) => {
    const keyId = keyIdOf(row.record) ?? PLAINTEXT_KEY_ID;
    byKeyId[keyId] = (byKeyId[keyId] ?? 0) + 1;
  });
  return { table, byKeyId };
}

/** Keyset pagination on the primary key, so a concurrent insert cannot skip a row. */
async function eachRecordRow(
  sql: SqlClient,
  table: string,
  batchSize: number,
  visit: (row: RecordRow) => Promise<void>,
): Promise<void> {
  let cursor = '';
  for (;;) {
    const page = await sql.query(
      `SELECT id, record FROM ${table} WHERE id > $1 ORDER BY id LIMIT $2`,
      [cursor, batchSize],
    );
    const rows = page.rows.map(toRecordRow).filter(isRecordRow);
    if (rows.length === 0) return;
    for (const row of rows) await visit(row);
    const last = rows[rows.length - 1];
    if (last === undefined) return;
    cursor = last.id;
  }
}

function toRecordRow(row: SqlRow): RecordRow | null {
  if (typeof row.id !== 'string' || typeof row.record !== 'string') return null;
  return { id: row.id, record: row.record };
}

function isRecordRow(row: RecordRow | null): row is RecordRow {
  return row !== null;
}
