/**
 * A command's action from what is written on its line alone: SQL statement, verb table,
 * reader, writer, then the generic classifiers. Pure, so an agent in somebody's cloud gets
 * the same action a laptop does; reading a `psql -f` file is passed in where a disk is.
 */
import { classifyBinary, classifyReader, COMMAND_CLASS } from './binary-class';
import { classifyWriter } from './writers';
import {
  inspectStatement,
  isDatabaseClient,
  nonLocalHost,
  SQL_RISK,
  statementIn,
} from './sql';
import {
  actionForCommand,
  classOf,
  environmentIn,
  refineVerb,
  targetIn,
  verbArgv,
  verbTableFor,
} from '../verbs/index';
import type { ToolClass } from '../discovery/classify';
import { ACTION } from '../constants/action.constants';
import { npmPublishIn } from './npm-workalike';

export interface ResolvedAction {
  action: string;
  class: ToolClass | string;
  /** Why this class, in the words a refusal will use. */
  because: string;
  /** What it operates on: a host, a path, a branch. Never a payload. */
  target?: string;
  /**
   * Every path this command names, when it names more than one, so anything gating a read
   * walks this rather than letting the second file of `cat README ~/.ssh/id_ed25519` through.
   */
  targets?: readonly string[];
  /** What to do instead, when the table names something. */
  alternative?: string;
  /** The HTTP method, for a command that makes a request. */
  method?: string;
  /** The environment the command names, as it named it, for a rule's `environments`. */
  environment?: string;
  /** LOCAL ONLY: the lines a write adds, where the line itself shows them. Never recorded. */
  content?: readonly string[];
}

export interface ResolveOptions {
  /** What the command reads on standard input, from a heredoc or a here-string. */
  stdin?: string;
}

/** What a command may read beyond its own line, given only where a disk is. */
export interface CommandIo {
  /** The statements in a file the client was pointed at, as `psql -f migrate.sql`. */
  statementFile?: (
    binary: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => string | null;
}

/** Most specific first: a SQL statement, then a verb table, a reader, a writer, the generic. */
export function resolveCommand(
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
  options: ResolveOptions & CommandIo = {},
): ResolvedAction {
  return (
    resolveSqlStatement(binary, args, env, options) ??
    resolveNpmWorkalike(binary, args, env) ??
    resolveFromVerbTable(binary, args, env) ??
    resolveReader(binary, args, env) ??
    resolveWriter(binary, args, env) ??
    resolveGeneric(binary, args) ?? {
      action: ACTION.SHELL_EXECUTE,
      class: COMMAND_CLASS.NORMAL,
      because: binary,
    }
  );
}

/** npm's workalikes publish to the same registry, so one rule covers all four. */
function resolveNpmWorkalike(
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): ResolvedAction | null {
  const publishing = npmPublishIn(binary, args);
  if (publishing === null) return null;
  const ruled = resolveFromVerbTable('npm', publishing.words, env);
  return ruled === null ? null : { ...ruled, because: publishing.because };
}

/** So `psql -c "DROP TABLE users"` is ruled on as a drop rather than as opening psql. */
function resolveSqlStatement(
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  options: ResolveOptions & CommandIo,
): ResolvedAction | null {
  if (!isDatabaseClient(binary)) return null;
  const statement =
    statementIn(binary, args, options.stdin) ??
    options.statementFile?.(binary, args, env) ??
    null;
  if (statement === null) return null;
  const sql = inspectStatement(binary, statement);
  // Unrecognised is handed to the client's own table, which knows a session can do anything.
  if (sql.risk === SQL_RISK.UNKNOWN) return null;
  const host = nonLocalHost(args, env);
  // An unbounded delete is its own action, the same way `git.push-force` is not `git.push`.
  const suffix = sql.risk === SQL_RISK.UNBOUNDED ? '-unbounded' : '';
  return {
    action: `${binary}.${sql.statement.toLowerCase()}${suffix}`,
    class: sql.class,
    because: host === null ? sql.because : `${sql.because}, on ${host}`,
    ...(host === null ? {} : { target: host }),
  };
}

function resolveFromVerbTable(
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): ResolvedAction | null {
  const table = verbTableFor(binary);
  if (table === null) return null;
  // Flags that come before the verb, as `kubectl --context prod delete`, are not the verb.
  const argv = verbArgv(table, args);
  const verb = refineVerb(table, argv, classOf(table, argv));
  const target = targetIn(verb, argv);
  const environment = environmentIn(table, args, env);
  return {
    action: actionForCommand(binary, table, argv, verb),
    class: verb.class,
    because: verb.note ?? `${binary} ${verb.match}`,
    ...(target === undefined ? {} : { target }),
    ...(verb.alternative === undefined ? {} : { alternative: verb.alternative }),
    ...(environment === undefined ? {} : { environment }),
  };
}

// Ahead of the generic classifiers, which have no opinion about a reader, so a
// `filesystem.read` rule about a credential file has an action to match.
function resolveReader(
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): ResolvedAction | null {
  const reading = classifyReader(binary, args, env);
  if (reading === null) return null;
  return {
    action: reading.action,
    class: reading.class,
    because: reading.because,
    ...(reading.target === undefined ? {} : { target: reading.target }),
    targets: reading.targets,
  };
}

export function resolveWriter(
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): ResolvedAction | null {
  const writing = classifyWriter(binary, args, env);
  if (writing === null || writing.targets.length === 0) return null;
  return {
    action: writing.action,
    class: writing.class,
    because: writing.because,
    ...(writing.target === undefined ? {} : { target: writing.target }),
    targets: writing.targets,
  };
}

function resolveGeneric(binary: string, args: readonly string[]): ResolvedAction | null {
  const generic = classifyBinary(binary, args);
  if (generic === null) return null;
  return {
    action: generic.action,
    class: generic.class,
    because: generic.because,
    ...(generic.target === undefined ? {} : { target: generic.target }),
    ...(generic.method === undefined ? {} : { method: generic.method }),
  };
}
