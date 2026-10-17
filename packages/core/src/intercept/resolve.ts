/**
 * One command line, one action name, for every surface with an opinion about a command,
 * because two resolvers would mean a rule written from one screen failing at another.
 */
import { classifyReader } from './binary-class';
import { loosens, MEMNOX_ACTION_PREFIX } from '../gate/self-protection';
import { namesProtected } from '../gate/protected-paths';
import { environmentRead, variablesPrinted } from './environment-reads';
import {
  resolveCommand,
  resolveWriter,
  type ResolveOptions,
  type ResolvedAction,
} from './command-action';
import { fileStatementIn } from './sql-file';
import { TOOL_CLASS } from '../discovery/classify';
import {
  normalizeShellCommand,
  OPAQUE_REASON,
  type OpaqueReason,
} from '../domain/shell-normalizer';
import { ACTION } from '../constants/action.constants';
import { basename, CODE_RUNNERS, underPrefixes } from '../domain/shell-runners';
import { awkMayWrite } from './awk';
import { shownWrites } from './shown-writes';

export type { CommandIo, ResolvedAction, ResolveOptions } from './command-action';

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
    resolveCommand(binary, args, env, { ...options, statementFile: fileStatementIn })
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
    normalized.opaque.some((reason) => reason !== OPAQUE_REASON.EXPANSION) ||
    namesHiddenCommand(normalized.parsed) ||
    runsInterpreter(line, normalized.parsed);
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

/**
 * Whether a command's own name is an expansion, as in `$EDITOR f`. One only in an argument,
 * as in `grep x $f`, leaves the program known, and its substitution was walked already.
 */
function namesHiddenCommand(parsed: readonly { argv: readonly string[] }[]): boolean {
  return parsed.some(({ argv }) => /[$`]/.test(argv[0] ?? ''));
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
    const binary = basename(underPrefixes(words)[0] ?? '');
    if (binary === 'sqlite3') return !words.includes('-readonly');
    return CODE_RUNNERS.has(binary.replace(/[\d.]+$/, ''));
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
