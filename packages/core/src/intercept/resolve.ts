import { classifyBinary, COMMAND_CLASS } from './binary-class';
import { inspectSql, isDatabaseClient, nonLocalHost, SQL_RISK, statementIn } from './sql';
import { actionForCommand, classOf, verbAction, verbTableFor } from '../verbs/index';
import { TOOL_CLASS, type ToolClass } from '../discovery/classify';

/**
 * One command line, one action name. Every surface that has an opinion about a command
 * — the scan, `explain`, `protect`, `policy test`, the interceptor — calls this. Two
 * resolvers would mean a rule written from one screen silently failing at another,
 * which is a gate nobody can trust.
 */

export interface ResolvedAction {
  action: string;
  class: ToolClass | string;
  /** Why this class, in the words a refusal will use. */
  because: string;
  /** What it operates on: a host, a path, a branch. Never a payload. */
  target?: string;
  /** What to do instead, when the table names something. */
  alternative?: string;
}

export function resolveAction(
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): ResolvedAction {
  /* A database client carries its statement in argv, so `psql -c "DROP TABLE users"`
     is ruled on as a drop rather than as "somebody opened psql". */
  if (isDatabaseClient(binary)) {
    const statement = statementIn(binary, args);
    if (statement !== null) {
      const sql = inspectSql(statement);
      const host = nonLocalHost(args, env);
      /* An unbounded delete is its own action, so a rule about "delete every row"
         cannot be written only as a rule about deletes. Same reason `git.push-force`
         is separate from `git.push`. */
      const suffix = sql.risk === SQL_RISK.UNBOUNDED ? '-unbounded' : '';
      return {
        action: `${binary}.${sql.statement.toLowerCase()}${suffix}`,
        class: sql.class,
        because: host === null ? sql.because : `${sql.because}, on ${host}`,
        ...(host === null ? {} : { target: host }),
      };
    }
  }

  const table = verbTableFor(binary);
  if (table !== null) {
    const verb = classOf(table, args);
    const target = args.find((arg) => !arg.startsWith('-'));
    return {
      action: actionForCommand(binary, table, args),
      class: verb.class,
      because: verb.note ?? `${binary} ${verb.match}`,
      ...(target === undefined ? {} : { target }),
      ...(verb.alternative === undefined ? {} : { alternative: verb.alternative }),
    };
  }

  const generic = classifyBinary(binary, args);
  if (generic !== null) {
    return {
      action: generic.action,
      class: generic.class,
      because: generic.because,
      ...(generic.target === undefined ? {} : { target: generic.target }),
    };
  }

  return {
    action: 'shell.execute',
    class: COMMAND_CLASS.NORMAL,
    because: binary,
  };
}

/** Kept so a caller with only a name can still ask what it would resolve to. */
export function actionNameFor(binary: string, args: readonly string[]): string {
  const table = verbTableFor(binary);
  if (table === null) return resolveAction(binary, args).action;
  return verbAction(binary, classOf(table, args));
}

export { TOOL_CLASS };
