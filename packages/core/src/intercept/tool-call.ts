/**
 * An MCP call classified by what it was handed as well as by its name, because a tool
 * named `query` that is handed `DROP TABLE users` is not a read.
 */
import { classifyTool, TOOL_CLASS, type Classification } from '../discovery/classify';
import { EFFECT_INFERENCE } from '../discovery/discovery.constants';
import { nameSegments, type McpToolDeclaration } from '../discovery/surface';
import { inspectSql, SQL_RISK } from './sql';

/** Argument names a database tool carries its statement in. */
const STATEMENT_ARGUMENTS = ['sql', 'query', 'statement', 'statements'];

/** Name words that say a tool talks to a database, so a search box's `query` is left alone. */
const DATABASE_WORDS = [
  'sql',
  'query',
  'execute',
  'exec',
  'db',
  'database',
  'postgres',
  'postgresql',
  'pg',
  'mysql',
  'sqlite',
  'supabase',
  'neon',
  'statement',
];

// A statement opens with its keyword; "update the docs" in a search box does not count.
const OPENS_LIKE_SQL =
  /^\s*(\(|SELECT|WITH|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|MERGE|COPY|CALL|DO|EXPLAIN|SHOW|DESCRIBE|VACUUM|REPLACE|EXEC|EXECUTE|BEGIN|TABLE|VALUES)\b/i;

/**
 * The name's class, overruled by the statement when there is one to read. A statement
 * nothing recognises leaves a read-looking tool unknown rather than trusted.
 */
export function classifyToolCall(
  name: string,
  args: Readonly<Record<string, unknown>> = {},
  declared?: McpToolDeclaration,
): Classification {
  // The server's own hints where it listed them, since it knows its tool better than a name.
  const named = classifyTool(declared ?? { name });
  const talksToDatabase = nameSegments(name).some((word) =>
    DATABASE_WORDS.includes(word),
  );
  const statement = talksToDatabase ? statementArgument(args) : null;
  if (statement === null || !OPENS_LIKE_SQL.test(statement)) return named;

  const sql = inspectSql(statement);
  if (sql.risk !== SQL_RISK.UNKNOWN) {
    return { class: sql.class, from: EFFECT_INFERENCE.NAME };
  }
  return named.class === TOOL_CLASS.READ
    ? { class: TOOL_CLASS.UNKNOWN, from: EFFECT_INFERENCE.NAME }
    : named;
}

function statementArgument(args: Readonly<Record<string, unknown>>): string | null {
  for (const key of STATEMENT_ARGUMENTS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (Array.isArray(value) && value.every((each) => typeof each === 'string')) {
      return value.join(';\n');
    }
  }
  return null;
}

/** Argument names an MCP call gives its environment under, as Railway's tools do. */
const ENVIRONMENT_ARGUMENTS = [
  'environment',
  'environmentName',
  'environment_name',
  'env',
  'stage',
];

/** The environment a call names in its own arguments, as it named it. */
export function environmentOfArguments(
  args: Readonly<Record<string, unknown>>,
): string | undefined {
  for (const key of ENVIRONMENT_ARGUMENTS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}
