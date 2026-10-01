/**
 * One command line, one action name, for every surface with an opinion about a command,
 * because two resolvers would mean a rule written from one screen failing at another.
 */
import { classifyBinary, classifyReader, COMMAND_CLASS } from './binary-class';
import { classifyWriter } from './writers';
import { loosens, MEMNOX_ACTION_PREFIX } from '../gate/self-protection';
import { namesProtected } from '../gate/protected-paths';
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
import {
  normalizeShellCommand,
  OPAQUE_REASON,
  type OpaqueReason,
} from '../domain/shell-normalizer';
import { ACTION } from '../constants/action.constants';
import { awkMayWrite } from './awk';
import { shownWrites } from './shown-writes';

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
    resolveMemnox(binary, args) ??
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

/**
 * A `memnox` command, by its subcommand, so self-protection can tell `memnox why` from
 * `memnox allow`, typed directly or through `npx`.
 */
function resolveMemnox(binary: string, args: readonly string[]): ResolvedAction | null {
  const words =
    binary === 'memnox'
      ? args
      : binary === 'npx' && (args[0] ?? '').startsWith('memnox')
        ? args.slice(1)
        : null;
  if (words === null) return null;
  const command = words.join(' ');
  return {
    action: `${MEMNOX_ACTION_PREFIX}${words[0] ?? 'scan'}`,
    class: loosens(command) ? TOOL_CLASS.WRITE : TOOL_CLASS.READ,
    because: `memnox ${command}`.trim(),
    target: command === '' ? 'scan' : command,
  };
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
  const redirected = [
    ...redirectActions(normalized.redirects, env),
    ...shownWrites(normalized.parsed, env),
  ];
  const printed = environmentRead(variablesPrinted(normalized.parsed));
  const all = [...actions, ...redirected, ...(printed === null ? [] : [printed])];
  const governing = governingChange(line, all, normalized);
  const hidden = hiddenCode(normalized.opaque);
  const reached = placesReached(line, all, normalized, env);
  return {
    actions: [
      ...all,
      ...(governing === null ? [] : [governing]),
      ...(hidden === null ? [] : [hidden]),
      ...reached,
    ],
    opaque: normalized.opaque,
  };
}

/** An absolute or home path written anywhere in a line, heredocs and quoted code included. */
const PATH_IN_LINE = /(?:^|[\s"'`=(:,;])(~?\/[\w.@+-]+(?:\/[\w.@+-]+)+)/g;

/** Where a line moves to before it acts: `cd X`, `pushd X`, and `git -C X`. */
function movesTo(parsed: readonly { argv: readonly string[] }[]): string[] {
  const found: string[] = [];
  for (const { argv } of parsed) {
    const [binary, ...args] = argv;
    if ((binary === 'cd' || binary === 'pushd') && args[0] !== undefined)
      found.push(args[0]);
    if (binary === 'git') {
      const at = args.indexOf('-C');
      const dir = at === -1 ? undefined : args[at + 1];
      if (dir !== undefined) found.push(dir);
    }
  }
  return found;
}

/**
 * Where a changing line reaches, as a write there, so the project boundary asks as it does
 * for the file tools: `cd /other && sed -i x f` and `python3 - <<EOF` named no write target.
 */
function placesReached(
  line: string,
  actions: readonly ResolvedAction[],
  normalized: ReturnType<typeof normalizeShellCommand>,
  env: NodeJS.ProcessEnv,
): ResolvedAction[] {
  // Code nobody here can read: every path it names could be one it writes.
  const unreadable =
    normalized.opaque.length > 0 || runsInterpreter(line, normalized.parsed);
  const changes =
    unreadable ||
    actions.some(
      (each) => each.class === TOOL_CLASS.WRITE || each.class === TOOL_CLASS.DESTRUCTIVE,
    );
  if (!changes) return [];
  const places = new Set<string>();
  for (const dir of movesTo(normalized.parsed)) places.add(`${absoluteFrom(dir, env)}/.`);
  if (unreadable) {
    for (const match of line.matchAll(PATH_IN_LINE)) {
      const path = match[1];
      if (path !== undefined && !path.startsWith('/dev/'))
        places.add(absoluteFrom(path, env));
    }
  }
  return [...places].map((target) => ({
    action: ACTION.FILESYSTEM_WRITE,
    class: TOOL_CLASS.WRITE,
    because: 'the line changes something and reaches this place',
    target,
  }));
}

/** Code the line runs that nobody here could read first, which a person is asked about. */
function hiddenCode(opaque: readonly OpaqueReason[]): ResolvedAction | null {
  const unreadable = opaque.filter(
    (each) => each === OPAQUE_REASON.REMOTE_SOURCE || each === OPAQUE_REASON.UNDECODABLE,
  );
  if (unreadable.length === 0) return null;
  return {
    action: ACTION.SHELL_HIDDEN,
    class: TOOL_CLASS.DESTRUCTIVE,
    because:
      unreadable[0] === OPAQUE_REASON.REMOTE_SOURCE
        ? 'it runs a download as code, so what runs is only known once it has run'
        : 'it decodes something and runs it, and what it decodes could not be read first',
  };
}

/** Interpreters whose code can write anywhere, whatever the rest of the line says. */
const INTERPRETERS: readonly string[] = [
  'python',
  'python3',
  'node',
  'deno',
  'bun',
  'ruby',
  'perl',
  'php',
  'osascript',
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'lua',
  'tclsh',
];

/** Words that only run the next one, so the command is what follows them. */
const PREFIXES: readonly string[] = [
  'env',
  'sudo',
  'command',
  'nohup',
  'nice',
  'timeout',
  'exec',
  'time',
  'xargs',
];

/**
 * Whether any command in the raw line starts an interpreter. Read off the line as typed,
 * because the normalizer unwraps `python -c` and walks the code as shell, which hides it.
 */
function runsInterpreter(
  line: string,
  parsed: readonly { argv: readonly string[] }[],
): boolean {
  if (parsed.some(({ argv }) => awkMayWrite(argv))) return true;
  return line.split(/[;&|()\n]+/).some((segment) => {
    const words = splitCommandLine(segment.trim());
    let at = 0;
    while (
      at < words.length &&
      (PREFIXES.includes(words[at] ?? '') ||
        /^\w+=/.test(words[at] ?? '') ||
        /^-/.test(words[at] ?? ''))
    )
      at += 1;
    const binary = (words[at] ?? '').split('/').pop() ?? '';
    if (binary === 'sqlite3') return !words.includes('-readonly');
    return INTERPRETERS.includes(binary.replace(/[\d.]+$/, ''));
  });
}

/**
 * A line naming what governs the agent that also changes something, runs code or hides part
 * of itself is a write there: `cd ~/.memnox && tee x` and `ln -s ~/.memnox g` name no path.
 */
function governingChange(
  line: string,
  actions: readonly ResolvedAction[],
  normalized: ReturnType<typeof normalizeShellCommand>,
): ResolvedAction | null {
  const named = namesProtected(line);
  if (named === null) return null;
  const changes =
    normalized.opaque.length > 0 ||
    runsInterpreter(line, normalized.parsed) ||
    actions.some(
      (each) => each.class === TOOL_CLASS.WRITE || each.class === TOOL_CLASS.DESTRUCTIVE,
    );
  if (!changes) return null;
  return {
    action: ACTION.FILESYSTEM_WRITE,
    class: TOOL_CLASS.WRITE,
    because: `the line names ${named} and changes something`,
    target: protectedTargetFor(named),
  };
}

function protectedTargetFor(named: string): string {
  if (named.startsWith('.memnox')) return '~/.memnox/';
  if (named === 'disableAllHooks' || named === 'allowUnsandboxedCommands')
    return '~/.claude/settings.json';
  return named;
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
