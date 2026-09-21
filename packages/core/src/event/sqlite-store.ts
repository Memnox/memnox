/**
 * The ledger on disk: every action an agent tried, and what happened to it. Append-only,
 * enforced by a trigger, and WAL because several short-lived seams write at once.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';

import { MEMNOX_HOME } from '../config/config';
import {
  EVENT_SURFACE,
  type EventQuery,
  type EventSink,
  type MemnoxEvent,
} from './event';
import { MIGRATIONS } from './event-migrations';
import { EVENT_COLUMNS, eventToRow, rowToEvent, type EventRow } from './event-row';

/** How long a writer waits on another's lock before failing, rather than stalling the agent. */
const BUSY_TIMEOUT_MS = 5_000;

export const DATABASE_FILE = 'memnox.db';

export function databasePathFor(home: string): string {
  return join(home, MEMNOX_HOME, DATABASE_FILE);
}

interface WhereClause {
  clause: string;
  params: Record<string, string>;
}

/** Named parameters only, so nothing a filter carries is ever spliced into the SQL. */
function whereClauseFor(filter: EventQuery): WhereClause {
  const where: string[] = [];
  const params: Record<string, string> = {};
  const equal = {
    sessionId: filter.sessionId,
    agent: filter.agent,
    surface: filter.surface,
  };
  for (const [column, value] of Object.entries(equal)) {
    if (value === undefined) continue;
    where.push(`${column} = @${column}`);
    params[column] = value;
  }
  if (filter.surface === undefined && filter.withConfig !== true) {
    where.push('surface <> @configSurface');
    params['configSurface'] = EVENT_SURFACE.CONFIG;
  }
  if (filter.since !== undefined) {
    where.push('at >= @since');
    params['since'] = filter.since;
  }
  if (filter.until !== undefined) {
    where.push('at <= @until');
    params['until'] = filter.until;
  }
  if (filter.effects !== undefined && filter.effects.length > 0) {
    const names = filter.effects.map((effect, index) => {
      params[`effect${index}`] = effect;
      return `@effect${index}`;
    });
    where.push(`effect IN (${names.join(', ')})`);
  }
  return { clause: where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`, params };
}

/**
 * WAL, because an interceptor, the proxy and a daemon all write while `timeline` reads. The
 * default rollback journal locks readers out, which would turn every concurrent tool
 * call into a stall the agent feels.
 */
export class SqliteEventStore implements EventSink {
  private readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
  }

  static forHome(home: string): SqliteEventStore {
    return new SqliteEventStore(databasePathFor(home));
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY)');
    const applied = new Set(
      this.db
        .prepare('SELECT version FROM migrations')
        .all()
        .map((row) => Number((row as { version: number }).version)),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.db.transaction(() => {
        this.db.exec(migration.sql);
        this.db
          .prepare('INSERT INTO migrations (version) VALUES (?)')
          .run(migration.version);
      })();
    }
  }

  async append(event: MemnoxEvent): Promise<void> {
    const placeholders = EVENT_COLUMNS.map((column) => `@${column}`).join(', ');
    // OR IGNORE, because a resent event must not become a second row.
    this.db
      .prepare(
        `INSERT OR IGNORE INTO events (${EVENT_COLUMNS.join(', ')}) VALUES (${placeholders})`,
      )
      .run(eventToRow(event));
  }

  async query(filter: EventQuery): Promise<MemnoxEvent[]> {
    const { clause, params } = whereClauseFor(filter);
    // Newest first with a limit, then reversed, so a month of history is never scanned whole.
    const limit = filter.limit === undefined ? '' : ` LIMIT ${Number(filter.limit)}`;
    const rows = this.db
      .prepare(`SELECT * FROM events${clause} ORDER BY at DESC, id DESC${limit}`)
      // Every row in `events` was written by `eventToRow`.
      .all(params) as EventRow[];
    return rows.map(rowToEvent).reverse();
  }

  /** Who released a held call. The only field a row may ever gain after the fact. */
  async recordAuthorization(id: string, authorizedBy: string): Promise<void> {
    this.db
      .prepare('UPDATE events SET authorizedBy = ? WHERE id = ? AND authorizedBy IS NULL')
      .run(authorizedBy, id);
  }

  /** Drops rows older than the cutoff and reports how many. Retention, not tidying. */
  async pruneBefore(cutoff: string): Promise<number> {
    const result = this.db.prepare('DELETE FROM events WHERE at < ?').run(cutoff);
    this.db.exec('VACUUM');
    return result.changes;
  }

  /** Kept so `why` can say what the rules were then, not what they are now. */
  async recordPolicyVersion(hash: string, at: string, contents: string): Promise<void> {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO policy_versions (hash, at, contents) VALUES (?, ?, ?)',
      )
      .run(hash, at, contents);
  }

  async policyVersion(hash: string): Promise<string | null> {
    const row = this.db
      .prepare('SELECT contents FROM policy_versions WHERE hash = ?')
      .get(hash) as { contents?: string } | undefined;
    return row === undefined || row.contents === undefined ? null : row.contents;
  }

  async count(): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as {
      n: number;
    };
    return row.n;
  }

  /**
   * How many recorded verdicts did not simply proceed, which is the work that would have
   * stopped had this machine been enforcing. Counted in SQL because `doctor` runs while somebody waits.
   */
  async countWithheld(): Promise<number> {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE effect <> 'allow'")
      .get() as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}
