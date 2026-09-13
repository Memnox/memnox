import { classifyBinary, classifyReader, COMMAND_CLASS } from './binary-class';
import { inspectSql, isDatabaseClient, nonLocalHost, SQL_RISK, statementIn } from './sql';
import {
  actionForCommand,
  classOf,
  targetIn,
  verbAction,
  verbTableFor,
} from '../verbs/index';
import { TOOL_CLASS, type ToolClass } from '../discovery/classify';
import { normalizeShellCommand, type OpaqueReason } from '../domain/shell-normalizer';

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
  /**
   * Every path this command names, when it names more than one. A caller that rules on
   * `target` alone rules on the first file of `cat README ~/.ssh/id_ed25519` and lets
   * the second through, so anything gating a read walks this instead.
   */
  targets?: readonly string[];
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
    const target = targetIn(verb, args);
    return {
      action: actionForCommand(binary, table, args),
      class: verb.class,
      because: verb.note ?? `${binary} ${verb.match}`,
      ...(target === undefined ? {} : { target }),
      ...(verb.alternative === undefined ? {} : { alternative: verb.alternative }),
    };
  }

  /* Before the generic classifiers, which have no opinion about a reader at all. A
     `filesystem.read` rule is the one thing every screen promises about a credential
     file, so this is where that promise becomes an action a gate can match. */
  const reading = classifyReader(binary, args, env);
  if (reading !== null) {
    return {
      action: reading.action,
      class: reading.class,
      because: reading.because,
      ...(reading.target === undefined ? {} : { target: reading.target }),
      targets: reading.targets,
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

/**
 * Every target one resolved command has to be ruled on, in order.
 *
 * A reader names all of its files, so `cat README ~/.ssh/id_ed25519` is two rulings and
 * the deny on the second is reached. Ruling on `target` alone stopped at the README,
 * which put the whole credential gate one argument away from being bypassed. Exported
 * because the shell seam and `policy test` must agree about this or a rule proven on
 * one would quietly not fire on the other.
 */
export function targetsRuledOn(
  resolved: Pick<ResolvedAction, 'target' | 'targets'>,
  fallback?: string,
): readonly (string | undefined)[] {
  if (resolved.targets !== undefined && resolved.targets.length > 0)
    return resolved.targets;
  return [resolved.target ?? fallback];
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
