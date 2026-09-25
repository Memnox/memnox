/**
 * One command line, one action name, for every surface with an opinion about a command,
 * because two resolvers would mean a rule written from one screen failing at another.
 */
import { classifyBinary, classifyReader, COMMAND_CLASS } from './binary-class';
import { inspectSql, isDatabaseClient, nonLocalHost, SQL_RISK, statementIn } from './sql';
import { actionForCommand, classOf, targetIn, verbTableFor } from '../verbs/index';
import type { ToolClass } from '../discovery/classify';
import { normalizeShellCommand, type OpaqueReason } from '../domain/shell-normalizer';
import { ACTION } from '../constants/action.constants';

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
}

/** Most specific first: a SQL statement, then a verb table, then a reader, then the generic classifiers. */
export function resolveAction(
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): ResolvedAction {
  return (
    resolveSqlStatement(binary, args, env) ??
    resolveFromVerbTable(binary, args) ??
    resolveReader(binary, args, env) ??
    resolveGeneric(binary, args) ?? {
      action: ACTION.SHELL_EXECUTE,
      class: COMMAND_CLASS.NORMAL,
      because: binary,
    }
  );
}

/** So `psql -c "DROP TABLE users"` is ruled on as a drop rather than as opening psql. */
function resolveSqlStatement(
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): ResolvedAction | null {
  if (!isDatabaseClient(binary)) return null;
  const statement = statementIn(binary, args);
  if (statement === null) return null;
  const sql = inspectSql(statement);
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
): ResolvedAction | null {
  const table = verbTableFor(binary);
  if (table === null) return null;
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

/**
 * Every target one resolved command has to be ruled on, in order, so the deny on the second
 * file of `cat README ~/.ssh/id_ed25519` is reached. Shared by the shell seam and `policy test`.
 */
export function targetsRuledOn(
  resolved: Pick<ResolvedAction, 'target' | 'targets'>,
  fallback?: string,
): readonly (string | undefined)[] {
  if (resolved.targets !== undefined && resolved.targets.length > 0)
    return resolved.targets;
  return [resolved.target ?? fallback];
}

/**
 * argv as the kernel would hand it over: quotes held together, order preserved, because a
 * verb pattern matches argv as typed, unlike `normalizeShellCommand`, which sorts flags.
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
 * two rulings rather than one opaque `shell.execute`, because a rule written from what `scan` and
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
