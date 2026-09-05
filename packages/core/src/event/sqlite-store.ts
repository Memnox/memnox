import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MEMNOX_HOME } from '../config/config';
import { matches, type EventQuery, type EventSink, type MemnoxEvent } from './event';

export const DATABASE_FILE = 'memnox.db';

export function databasePathFor(home: string): string {
  return join(home, MEMNOX_HOME, DATABASE_FILE);
}

/**
 * Each migration runs once, in order, inside a transaction. Numbered rather than
 * hashed so a half-applied upgrade is obvious in the table rather than mysterious.
 */
const MIGRATIONS: readonly { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE events (
        id            TEXT PRIMARY KEY,
        schemaVersion INTEGER NOT NULL,
        at            TEXT NOT NULL,
        sessionId     TEXT NOT NULL,
        agent         TEXT NOT NULL,
        actorType     TEXT NOT NULL,
        principal     TEXT,
        surface       TEXT NOT NULL,
        operation     TEXT NOT NULL,
        target        TEXT,
        class         TEXT NOT NULL,
        effect        TEXT NOT NULL,
        shadowEffect  TEXT,
        mode          TEXT NOT NULL,
        reason        TEXT NOT NULL,
        ruleName      TEXT,
        ruleLayer     TEXT,
        ruleFile      TEXT,
        ruleLine      INTEGER,
        altAction     TEXT,
        altResource   TEXT,
        altNote       TEXT,
        policyHash    TEXT,
        argsDigest    TEXT,
        execution     TEXT,
        exitCode      INTEGER,
        durationMs    INTEGER,
        outputDigest  TEXT,
        authorizedBy  TEXT
      );
      CREATE INDEX events_at ON events (at);
      CREATE INDEX events_session ON events (sessionId, at);
      CREATE INDEX events_effect ON events (effect, at);

      /* Append-only, enforced by the database rather than by everyone remembering.
         The one legal update is releasing a held call, which the trigger allows by
         name: a record that could be edited is a claim about the past, not the past. */
      CREATE TRIGGER events_no_update BEFORE UPDATE ON events
      WHEN OLD.authorizedBy IS NOT NULL OR NEW.authorizedBy IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'events are append-only');
      END;

      CREATE TABLE policy_versions (
        hash      TEXT PRIMARY KEY,
        at        TEXT NOT NULL,
        contents  TEXT NOT NULL
      );

      CREATE TABLE sessions (
        id        TEXT PRIMARY KEY,
        agent     TEXT NOT NULL,
        startedAt TEXT NOT NULL,
        endedAt   TEXT
      );
    `,
  },
];

interface Row {
  [column: string]: string | number | null;
}

function toRow(event: MemnoxEvent): Row {
  const rule = event.rule;
  const alternative = event.alternative;
  return {
    id: event.id,
    schemaVersion: event.schemaVersion,
    at: event.at,
    sessionId: event.sessionId,
    agent: event.agent,
    actorType: event.actorType,
    principal: event.principal ?? null,
    surface: event.surface,
    operation: event.operation,
    target: event.target ?? null,
    class: event.class,
    effect: event.effect,
    shadowEffect: event.shadowEffect ?? null,
    mode: event.mode,
    reason: event.reason,
    ruleName: rule === undefined ? null : rule.name,
    ruleLayer: rule === undefined ? null : rule.layer,
    ruleFile: rule === undefined ? null : rule.file,
    ruleLine: rule === undefined || rule.line === undefined ? null : rule.line,
    altAction: alternative === undefined ? null : alternative.action,
    altResource:
      alternative === undefined || alternative.resource === undefined
        ? null
        : alternative.resource,
    altNote: alternative === undefined ? null : alternative.note,
    policyHash: event.policyHash ?? null,
    argsDigest: event.argsDigest ?? null,
    execution: event.execution ?? null,
    exitCode: event.exitCode ?? null,
    durationMs: event.durationMs ?? null,
    outputDigest: event.outputDigest ?? null,
    authorizedBy: event.authorizedBy ?? null,
  };
}

function fromRow(row: Row): MemnoxEvent {
  const text = (key: string): string | undefined => {
    const value = row[key];
    return value === null || value === undefined ? undefined : String(value);
  };
  const number = (key: string): number | undefined => {
    const value = row[key];
    return value === null || value === undefined ? undefined : Number(value);
  };
  const ruleName = text('ruleName');
  const altAction = text('altAction');

  const event: MemnoxEvent = {
    id: String(row['id']),
    schemaVersion: Number(row['schemaVersion']),
    at: String(row['at']),
    sessionId: String(row['sessionId']),
    agent: String(row['agent']),
    actorType: String(row['actorType']) as MemnoxEvent['actorType'],
    surface: String(row['surface']) as MemnoxEvent['surface'],
    operation: String(row['operation']),
    class: String(row['class']) as MemnoxEvent['class'],
    effect: String(row['effect']) as MemnoxEvent['effect'],
    mode: String(row['mode']) as MemnoxEvent['mode'],
    reason: String(row['reason']),
  };

  const optional: [keyof MemnoxEvent, string | undefined][] = [
    ['principal', text('principal')],
    ['target', text('target')],
    ['shadowEffect', text('shadowEffect')],
    ['policyHash', text('policyHash')],
    ['argsDigest', text('argsDigest')],
    ['execution', text('execution')],
    ['outputDigest', text('outputDigest')],
    ['authorizedBy', text('authorizedBy')],
  ];
  for (const [key, value] of optional) {
    if (value !== undefined) Object.assign(event, { [key]: value });
  }
  for (const key of ['exitCode', 'durationMs'] as const) {
    const value = number(key);
    if (value !== undefined) event[key] = value;
  }

  if (ruleName !== undefined) {
    const line = number('ruleLine');
    event.rule = {
      name: ruleName,
      layer: text('ruleLayer') ?? 'project',
      file: text('ruleFile') ?? '',
      ...(line === undefined ? {} : { line }),
    };
  }
  if (altAction !== undefined) {
    const resource = text('altResource');
    event.alternative = {
      action: altAction,
      note: text('altNote') ?? '',
      ...(resource === undefined ? {} : { resource }),
    };
  }
  return event;
}

const COLUMNS = Object.keys(
  toRow({
    id: '',
    schemaVersion: 1,
    at: '',
    sessionId: '',
    agent: '',
    actorType: 'agent',
    surface: 'mcp',
    operation: '',
    class: 'read',
    effect: 'allow',
    mode: 'observe',
    reason: '',
  }),
);

/**
 * WAL, because a shim, the proxy and a daemon all write while `timeline` reads. The
 * default rollback journal locks readers out, which would turn every concurrent tool
 * call into a stall the agent feels.
 */
export class SqliteEventStore implements EventSink {
  private readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
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
    const placeholders = COLUMNS.map((column) => `@${column}`).join(', ');
    // OR IGNORE, because a resent event must not become a second row.
    this.db
      .prepare(
        `INSERT OR IGNORE INTO events (${COLUMNS.join(', ')}) VALUES (${placeholders})`,
      )
      .run(toRow(event));
  }

  async query(filter: EventQuery): Promise<MemnoxEvent[]> {
    const where: string[] = [];
    const params: Record<string, string> = {};
    if (filter.sessionId !== undefined) {
      where.push('sessionId = @sessionId');
      params['sessionId'] = filter.sessionId;
    }
    if (filter.agent !== undefined) {
      where.push('agent = @agent');
      params['agent'] = filter.agent;
    }
    if (filter.surface !== undefined) {
      where.push('surface = @surface');
      params['surface'] = filter.surface;
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

    const clause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`;
    /* Newest first with a limit, then reversed: an unbounded scan on a laptop that
       has been observing for a month is the stall this store exists to avoid. */
    const limit = filter.limit === undefined ? '' : ` LIMIT ${Number(filter.limit)}`;
    const rows = this.db
      .prepare(`SELECT * FROM events${clause} ORDER BY at DESC, id DESC${limit}`)
      .all(params) as Row[];
    return rows.map(fromRow).reverse();
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

  close(): void {
    this.db.close();
  }
}

/** Exposed so a caller can filter in memory against exactly the store's rules. */
export const eventMatches = matches;
