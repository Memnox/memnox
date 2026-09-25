/**
 * A database client takes its statement as an argument, so `psql -c "DROP TABLE users"`
 * is ruled on as a drop rather than as a connection.
 */
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

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

// Any object, since a dropped view or function is as gone as a dropped table.
const DROPPING = /\b(DROP|TRUNCATE)\b/i;
const DELETING = /\bDELETE\s+FROM\b/i;
const UPDATING = /\bUPDATE\b/i;
// `COPY ... FROM` loads rows; `SELECT ... INTO` makes a table; the rest change the schema,
// run code, or rewrite storage.
const WRITING =
  /\b(INSERT|ALTER|CREATE|GRANT|REVOKE|REPLACE|MERGE|COPY\s+\S+(\s*\([^)]*\))?\s+FROM|SELECT\b[^;]*\bINTO\b|DO|CALL|EXEC(UTE)?|VACUUM|REINDEX|CLUSTER|REFRESH|LOCK|COMMENT\s+ON|SECURITY\s+LABEL|IMPORT|LOAD)\b/i;
// A psql meta-command such as `\dt` only ever describes.
const READING =
  /\b(SELECT|SHOW|EXPLAIN|DESCRIBE|DESC|WITH|TABLE|VALUES|COPY)\b|^\\[a-z]/i;
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

/**
 * Every statement on this command line, joined, since `psql -c "SELECT 1" -c "DROP TABLE t"`
 * runs both. Null when this binary takes no statement, or none was passed.
 */
export function statementIn(
  binary: string,
  args: readonly string[],
  stdin?: string,
): string | null {
  const flags = STATEMENT_FLAGS[binary];
  if (flags === undefined) return null;

  const statements: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    // Inside the bounds the loop checks, so never undefined.
    const arg = args[index] as string;
    for (const flag of flags) {
      if (arg === flag) {
        const value = args[index + 1];
        if (value !== undefined) statements.push(value);
        index += 1;
        break;
      }
      // `-c"SELECT 1"` and `--eval=x` are both ordinary ways to write it.
      if (arg.startsWith(`${flag}=`)) {
        statements.push(arg.slice(flag.length + 1));
        break;
      }
      if (flag.length === 2 && arg.startsWith(flag) && arg.length > 2) {
        statements.push(arg.slice(2));
        break;
      }
    }
  }
  // `sqlite3 app.db "DROP TABLE t"` takes the statement as the second positional.
  if (binary === 'sqlite3') {
    const positional = args.filter((arg) => !arg.startsWith('-'));
    if (positional[1] !== undefined) statements.push(positional[1]);
  }
  if (stdin !== undefined && stdin.trim() !== '') statements.push(stdin);
  return statements.length === 0 ? null : statements.join(';\n');
}

const MONGO_RULES: readonly {
  pattern: RegExp;
  risk: SqlRisk;
  class: ToolClass;
  because?: string;
}[] = [
  {
    pattern: /\.(drop|dropDatabase|dropIndex(es)?|dropUser|dropAllUsers)\s*\(/,
    risk: SQL_RISK.DROPS,
    class: TOOL_CLASS.DESTRUCTIVE,
    because: 'it drops a collection or a database',
  },
  {
    pattern: /\.(deleteMany|remove|updateMany)\s*\(\s*(\{\s*\})?\s*[,)]/,
    risk: SQL_RISK.UNBOUNDED,
    class: TOOL_CLASS.DESTRUCTIVE,
    because: 'an empty filter is every document',
  },
  {
    pattern:
      /\.(insert\w*|update\w*|delete\w*|remove|replaceOne|findOneAnd\w+|findAndModify|bulkWrite|create\w*|rename\w*|save|grant\w*|revoke\w*|runCommand|adminCommand|eval)\s*\(|\$(out|merge)\b/,
    risk: SQL_RISK.WRITES,
    class: TOOL_CLASS.WRITE,
  },
  {
    pattern:
      /\.(find|findOne|aggregate|count\w*|estimatedDocumentCount|distinct|getCollectionNames|getCollectionInfos|getIndexes|stats|explain|listCollections|serverStatus|version|hostInfo)\s*\(|^\s*show\s+\w+|^\s*(db|use\s+\w+)\s*;?\s*$/m,
    risk: SQL_RISK.READS,
    class: TOOL_CLASS.READ,
  },
];

/** mongosh takes JavaScript rather than SQL, so it is read by its method names instead. */
export function inspectMongo(raw: string): SqlFinding {
  const script = raw
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/\/\/[^\n]*/g, ' ');
  const statement = /\.(\w+)\s*\(/.exec(script)?.[1] ?? 'unknown';
  // First match wins, most dangerous first, as the SQL rules are ordered.
  const rule = MONGO_RULES.find((candidate) => candidate.pattern.test(script));
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
    because: rule.because ?? `it calls ${statement}`,
    statement,
  };
}

/** The statement read by the grammar its client speaks. */
export function inspectStatement(binary: string, statement: string): SqlFinding {
  return binary === 'mongosh' ? inspectMongo(statement) : inspectSql(statement);
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

/** Flags whose value is a file of statements, per client. */
const FILE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  psql: ['-f', '--file'],
};

/** Past this the file is not read, and the command stays the write its client table says. */
const MOST_STATEMENT_BYTES = 512 * 1024;

/**
 * The statements in a file the client was pointed at, as `psql -f migrate.sql`. Null when
 * there is none, it is too big, or it will not read, which leaves the command a write.
 */
export function fileStatementIn(
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): string | null {
  const flags = FILE_FLAGS[binary];
  if (flags === undefined) return null;
  const path = valueAfter(args, flags);
  if (path === undefined || path === '-') return null;
  const absolute = isAbsolute(path) ? path : join(env['PWD'] ?? process.cwd(), path);
  try {
    if (statSync(absolute).size > MOST_STATEMENT_BYTES) return null;
    return readFileSync(absolute, 'utf8');
  } catch {
    // A file that will not read is one nothing here can vouch for.
    return null;
  }
}

function valueAfter(
  args: readonly string[],
  flags: readonly string[],
): string | undefined {
  for (const [index, arg] of args.entries()) {
    if (flags.includes(arg)) return args[index + 1];
    const inline = flags.find(
      (flag) => flag.startsWith('--') && arg.startsWith(`${flag}=`),
    );
    if (inline !== undefined) return arg.slice(inline.length + 1);
  }
  return undefined;
}
