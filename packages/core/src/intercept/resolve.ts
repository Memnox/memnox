import { classifyBinary, COMMAND_CLASS } from './binary-class';
import { inspectSql, isDatabaseClient, nonLocalHost, SQL_RISK, statementIn } from './sql';
import { actionForCommand, classOf, verbAction, verbTableFor } from '../verbs/index';
import { TOOL_CLASS, type ToolClass } from '../discovery/classify';
import {
  normalizeShellCommand,
  type OpaqueReason,
} from '../domain/shell-normalizer';

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

/**
 * argv as the kernel would hand it over: quotes held together, order preserved.
 * `normalizeShellCommand` sorts flags ahead of positionals, which is right for spotting
 * a destructive pattern in a whole line and wrong here — a verb pattern matches argv in
 * the order it was typed, so `git push --force` must not become `git --force push`.
 */
export function splitCommandLine(input: string): string[] {
  return (input.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((word) =>
    word.replace(/^["']|["']$/g, ''),
  );
}

export interface ResolvedShellLine {
  /** One per command in the line, in the order they would run. */
  actions: ResolvedAction[];
  /** Indirection nothing could see through, so a caller can say the answer is partial. */
  opaque: OpaqueReason[];
}

/**
 * A whole shell line, resolved command by command. `gh pr merge && vercel deploy` is
 * two rulings, not one opaque `shell.execute` — a rule written from what `scan` and
 * `explain` showed has to fire on the surface an agent actually types into.
 */
export function resolveShellLine(
  line: string,
  env: NodeJS.ProcessEnv = {},
): ResolvedShellLine {
  const normalized = normalizeShellCommand(line);
  const actions: ResolvedAction[] = [];
  // The literal form: a verb table matches argv in the order somebody typed it.
  for (const command of normalized.commands) {
    const argv = splitCommandLine(command);
    const binary = argv[0];
    if (binary === undefined) continue;
    actions.push(resolveAction(binary, argv.slice(1), env));
  }
  return { actions, opaque: normalized.opaque };
}
