import { TOOL_CLASS, type ToolClass } from '../discovery/classify';

/**
 * A database client takes its statement as an argument, so the argv that reaches an
 * interceptor already contains the whole thing. `psql -c "DROP TABLE users"` is not a
 * database connection, it is a delete — and reading which one it is from the statement
 * is the only way a rule about dropping tables can ever match.
 */

/** Flags whose value is the statement itself, per client. */
const STATEMENT_FLAGS: Readonly<Record<string, readonly string[]>> = {
  psql: ['-c', '--command'],
  mysql: ['-e', '--execute'],
  mongosh: ['--eval'],
  sqlite3: [],
};

export const SQL_RISK = {
  /** Drops or truncates. The table is gone and no transaction brings it back. */
  DROPS: 'drops',
  /** A delete or update with no WHERE, which is every row. */
  UNBOUNDED: 'unbounded',
  /** An ordinary write. */
  WRITES: 'writes',
  READS: 'reads',
  /** Nothing recognisable. Reported as unknown, never assumed harmless. */
  UNKNOWN: 'unknown',
} as const;

export type SqlRisk = (typeof SQL_RISK)[keyof typeof SQL_RISK];

export interface SqlFinding {
  risk: SqlRisk;
  class: ToolClass;
  /** The clause that decided it, so the refusal can quote the reason. */
  because: string;
  /** The statement's leading keyword. Never the whole statement, which holds values. */
  statement: string;
}

/** Strips string literals and comments, so a value can never look like a keyword. */
function scrub(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const DROPPING = /\b(DROP\s+(TABLE|DATABASE|SCHEMA|INDEX)|TRUNCATE)\b/i;
const DELETING = /\bDELETE\s+FROM\b/i;
const UPDATING = /\bUPDATE\b/i;
const WRITING = /\b(INSERT|ALTER|CREATE|GRANT|REVOKE|REPLACE|MERGE)\b/i;
const READING = /\b(SELECT|SHOW|EXPLAIN|DESCRIBE|WITH)\b/i;
const HAS_WHERE = /\bWHERE\b/i;

/**
 * Read from the statement rather than the tool. A `WHERE` clause is the difference
 * between deleting a row and deleting a table's worth of rows, and it is the only
 * signal available before the query runs.
 */
export function inspectSql(raw: string): SqlFinding {
  const sql = scrub(raw);
  const statement = (/^[A-Za-z]+/.exec(sql)?.[0] ?? 'unknown').toUpperCase();

  if (DROPPING.test(sql)) {
    return {
      risk: SQL_RISK.DROPS,
      class: TOOL_CLASS.DESTRUCTIVE,
      because: 'it drops or truncates, and no transaction brings that back',
      statement,
    };
  }
  if (DELETING.test(sql) && !HAS_WHERE.test(sql)) {
    return {
      risk: SQL_RISK.UNBOUNDED,
      class: TOOL_CLASS.DESTRUCTIVE,
      because: 'a DELETE with no WHERE is every row',
      statement,
    };
  }
  if (UPDATING.test(sql) && !HAS_WHERE.test(sql)) {
    return {
      risk: SQL_RISK.UNBOUNDED,
      class: TOOL_CLASS.DESTRUCTIVE,
      because: 'an UPDATE with no WHERE is every row',
      statement,
    };
  }
  if (DELETING.test(sql) || UPDATING.test(sql) || WRITING.test(sql)) {
    return {
      risk: SQL_RISK.WRITES,
      class: TOOL_CLASS.WRITE,
      because: `it is a ${statement}`,
      statement,
    };
  }
  if (READING.test(sql)) {
    return {
      risk: SQL_RISK.READS,
      class: TOOL_CLASS.READ,
      because: `it is a ${statement}`,
      statement,
    };
  }
  return {
    risk: SQL_RISK.UNKNOWN,
    class: TOOL_CLASS.UNKNOWN,
    because: 'no statement here was recognised',
    statement,
  };
}

/** Null when this binary takes no statement, or none was passed on this command line. */
export function statementIn(binary: string, args: readonly string[]): string | null {
  const flags = STATEMENT_FLAGS[binary];
  if (flags === undefined) return null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    for (const flag of flags) {
      if (arg === flag) return args[index + 1] ?? null;
      // `-c"SELECT 1"` and `--eval=x` are both ordinary ways to write it.
      if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
      if (flag.length === 2 && arg.startsWith(flag) && arg.length > 2) {
        return arg.slice(2);
      }
    }
  }
  return null;
}

export function isDatabaseClient(binary: string): boolean {
  return STATEMENT_FLAGS[binary] !== undefined;
}

/** The host a client is pointed at, which decides whether this is somebody else's data. */
export function nonLocalHost(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): string | null {
  const url = env['DATABASE_URL'] ?? env['MONGODB_URI'];
  const flagged = args[args.indexOf('-h') + 1] ?? args[args.indexOf('--host') + 1];
  const candidate = flagged !== undefined && args.includes('-h') ? flagged : url;
  if (candidate === undefined) return null;

  const host = /^\w+:\/\//.test(candidate)
    ? (() => {
        try {
          return new URL(candidate).hostname;
        } catch {
          // Not a URL after all; the raw value is the best answer available.
          return candidate;
        }
      })()
    : candidate;

  const local = ['localhost', '127.0.0.1', '::1', '0.0.0.0'];
  return local.includes(host) ? null : host;
}
