/** The ledger's schema: its migrations, and the trigger that keeps `events` append-only. */

/**
 * Every column of `events` except the one a release is allowed to fill in, written out
 * so a column somebody adds and forgets fails a test instead of going unguarded.
 */
export const IMMUTABLE_COLUMNS = [
  'id',
  'schemaVersion',
  'at',
  'sessionId',
  'agent',
  'actorType',
  'principal',
  'surface',
  'operation',
  'target',
  'class',
  'effect',
  'shadowEffect',
  'mode',
  'reason',
  'ruleName',
  'ruleLayer',
  'ruleFile',
  'ruleLine',
  'altAction',
  'altResource',
  'altNote',
  'policyHash',
  'argsDigest',
  'execution',
  'exitCode',
  'durationMs',
  'outputDigest',
  'costUsd',
  'bundleHash',
  'conditionsInForce',
] as const;

/** The column a held call's release fills in, and the only one that may change. */
export const RELEASE_COLUMN = 'authorizedBy';

/**
 * Append-only, enforced by the database. The one legal update is releasing a held call:
 * `authorizedBy` going from null to a name, once, with nothing else moving.
 */
export function appendOnlyTrigger(): string {
  const unchanged = IMMUTABLE_COLUMNS.map(
    (column) => `NEW.${column} IS NOT OLD.${column}`,
  ).join('\n        OR ');
  return `CREATE TRIGGER events_no_update BEFORE UPDATE ON events
      WHEN OLD.${RELEASE_COLUMN} IS NOT NULL
        OR NEW.${RELEASE_COLUMN} IS NULL
        OR ${unchanged}
      BEGIN
        SELECT RAISE(ABORT, 'events are append-only');
      END;`;
}

export interface Migration {
  version: number;
  sql: string;
}

/** Each runs once, in order, inside a transaction, numbered so a half-applied upgrade is obvious. */
export const MIGRATIONS: readonly Migration[] = [
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

      -- Append-only: the one legal update is releasing a held call.
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
  {
    // Nullable, because absent means nobody reported a cost and that is not zero.
    version: 2,
    sql: 'ALTER TABLE events ADD COLUMN costUsd REAL;',
  },
  {
    // The bundle and conditions a verdict was reached under, so a decision can be replayed.
    version: 3,
    sql: `ALTER TABLE events ADD COLUMN bundleHash TEXT;
          ALTER TABLE events ADD COLUMN conditionsInForce TEXT;`,
  },
  {
    // The check is that nothing but `authorizedBy` moved, so a release cannot rewrite
    // the row around it. `IS NOT` rather than `<>`, because it is null-safe.
    version: 4,
    sql: `
      DROP TRIGGER IF EXISTS events_no_update;
      ${appendOnlyTrigger()}
    `,
  },
];
