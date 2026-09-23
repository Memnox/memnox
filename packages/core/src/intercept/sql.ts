/**
 * A database client takes its statement as an argument, so `psql -c "DROP TABLE users"`
 * is ruled on as a drop rather than as a connection.
 */
import { TOOL_CLASS, type ToolClass } from '../discovery/classify';

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

interface SqlRule {
  applies: (sql: string) => boolean;
  risk: SqlRisk;
  class: ToolClass;
  because: (statement: string) => string;
}

function isUnbounded(pattern: RegExp): (sql: string) => boolean {
  return (sql) => pattern.test(sql) && !HAS_WHERE.test(sql);
}

/** First match wins, most dangerous first. A `WHERE` is the difference between a row and every row. */
const SQL_RULES: readonly SqlRule[] = [
  {
    applies: (sql) => DROPPING.test(sql),
    risk: SQL_RISK.DROPS,
    class: TOOL_CLASS.DESTRUCTIVE,
    because: () => 'it drops or truncates, and no transaction brings that back',
  },
  {
    applies: isUnbounded(DELETING),
    risk: SQL_RISK.UNBOUNDED,
    class: TOOL_CLASS.DESTRUCTIVE,
    because: () => 'a DELETE with no WHERE is every row',
  },
  {
    applies: isUnbounded(UPDATING),
    risk: SQL_RISK.UNBOUNDED,
    class: TOOL_CLASS.DESTRUCTIVE,
    because: () => 'an UPDATE with no WHERE is every row',
  },
  {
    applies: (sql) => DELETING.test(sql) || UPDATING.test(sql) || WRITING.test(sql),
    risk: SQL_RISK.WRITES,
    class: TOOL_CLASS.WRITE,
    because: (statement) => `it is a ${statement}`,
  },
  {
    applies: (sql) => READING.test(sql),
    risk: SQL_RISK.READS,
    class: TOOL_CLASS.READ,
    because: (statement) => `it is a ${statement}`,
  },
];

/** Read from the statement rather than the tool, which is the only signal before the query runs. */
export function inspectSql(raw: string): SqlFinding {
  const sql = scrub(raw);
  const statement = (/^[A-Za-z]+/.exec(sql)?.[0] ?? 'unknown').toUpperCase();
  const rule = SQL_RULES.find((candidate) => candidate.applies(sql));
  if (rule === undefined) {
    return {
      risk: SQL_RISK.UNKNOWN,
      class: TOOL_CLASS.UNKNOWN,
      because: 'no statement here was recognised',
      statement,
    };
  }
  return {
    risk: rule.risk,
    class: rule.class,
    because: rule.because(statement),
    statement,
  };
}

/** Null when this binary takes no statement, or none was passed on this command line. */
export function statementIn(binary: string, args: readonly string[]): string | null {
  const flags = STATEMENT_FLAGS[binary];
  if (flags === undefined) return null;

  for (let index = 0; index < args.length; index += 1) {
    // Inside the bounds the loop checks, so never undefined.
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

const HOST_FLAGS = ['-h', '--host'];
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '0.0.0.0'];

/** The host a client is pointed at, which decides whether this is somebody else's data. */
export function nonLocalHost(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): string | null {
  const target = hostFlagIn(args) ?? env['DATABASE_URL'] ?? env['MONGODB_URI'];
  if (target === undefined) return null;
  const host = hostnameOf(target);
  return LOCAL_HOSTS.includes(host) ? null : host;
}

/** The value after `-h` or `--host`, or glued to `--host=`; a flag given last has none. */
function hostFlagIn(args: readonly string[]): string | undefined {
  for (const [index, arg] of args.entries()) {
    if (HOST_FLAGS.includes(arg)) return args[index + 1];
    if (arg.startsWith('--host=')) return arg.slice('--host='.length);
  }
  return undefined;
}

function hostnameOf(target: string): string {
  if (!/^\w+:\/\//.test(target)) return target;
  try {
    return new URL(target).hostname;
  } catch {
    // Not a URL after all; the raw value is the best answer available.
    return target;
  }
}
