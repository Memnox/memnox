/**
 * One command line, one action name, for every surface with an opinion about a command,
 * because two resolvers would mean a rule written from one screen failing at another.
 */
import { classifyBinary, classifyReader, COMMAND_CLASS } from './binary-class';
import { classifyWriter } from './writers';
import { environmentRead, variablesPrinted } from './environment-reads';
import {
  fileStatementIn,
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
import { TOOL_CLASS } from '../discovery/classify';
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
  /** The environment the command names, as it named it, for a rule's `environments`. */
  environment?: string;
}

export interface ResolveOptions {
  /** What the command reads on standard input, from a heredoc or a here-string. */
  stdin?: string;
}

/**
 * Most specific first: a SQL statement, then a verb table, then a reader, then a writer,
 * then the generic classifiers.
 */
export function resolveAction(
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
  options: ResolveOptions = {},
): ResolvedAction {
  return (
    resolveSqlStatement(binary, args, env, options.stdin) ??
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

/** So `psql -c "DROP TABLE users"` is ruled on as a drop rather than as opening psql. */
function resolveSqlStatement(
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  stdin?: string,
): ResolvedAction | null {
  if (!isDatabaseClient(binary)) return null;
  const statement =
    statementIn(binary, args, stdin) ?? fileStatementIn(binary, args, env);
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

function resolveWriter(
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
  for (const command of normalized.parsed) {
    const [path, ...args] = command.argv;
    if (path === undefined) continue;
    const binary = path.split('/').pop() ?? path;
    const resolved = resolveAction(
      binary,
      args,
      env,
      command.stdin === undefined ? {} : { stdin: command.stdin },
    );
    actions.push(resolved);
    // `cp` is ruled on as a read of its source, and its destination is a write as well.
    if (resolved.action === ACTION.FILESYSTEM_READ) {
      const written = resolveWriter(binary, args, env);
      if (written !== null) actions.push(written);
    }
    // A move takes the file away as surely as a copy reads it.
    if (binary === 'mv') {
      const moved = classifyReader('cp', args, env);
      if (moved !== null && moved.targets.length > 0) {
        actions.push({ ...moved, because: 'mv takes the file it is given' });
      }
    }
  }
  const redirected = redirectActions(normalized.redirects, env);
  const printed = environmentRead(variablesPrinted(normalized.parsed));
  return {
    actions: [...actions, ...redirected, ...(printed === null ? [] : [printed])],
    opaque: normalized.opaque,
  };
}

/** `> file` and `< file` as the writes and reads they are, which argv never shows. */
function redirectActions(
  redirects: { writes: readonly string[]; reads: readonly string[] },
  env: NodeJS.ProcessEnv,
): ResolvedAction[] {
  const actions: ResolvedAction[] = [];
  const writes = redirects.writes.map((path) => absoluteFrom(path, env));
  const reads = redirects.reads.map((path) => absoluteFrom(path, env));
  if (writes.length > 0) {
    actions.push({
      action: ACTION.FILESYSTEM_WRITE,
      class: TOOL_CLASS.WRITE,
      because: 'a redirect writes the file',
      target: writes[0] as string,
      targets: writes,
    });
  }
  if (reads.length > 0) {
    actions.push({
      action: ACTION.FILESYSTEM_READ,
      class: TOOL_CLASS.READ,
      because: 'a redirect reads the file',
      target: reads[0] as string,
      targets: reads,
    });
  }
  return actions;
}

function absoluteFrom(path: string, env: NodeJS.ProcessEnv): string {
  // A reader's path rules, so a redirect names a file the way `cat` would.
  return classifyReader('cat', [path], env)?.target ?? path;
}
