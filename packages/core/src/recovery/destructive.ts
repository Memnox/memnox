/**
 * The commands worth a milestone before they run: the ones that delete or overwrite work in
 * a working tree and leave git nothing to get it back from. Read from argv alone, so a seam
 * can ask on every command without starting a process.
 */
import { basename } from 'node:path';
import { normalizeShellCommand } from '../domain/shell-normalizer';
import { splitCommandLine } from '../intercept/resolve';

/** One command that is about to destroy work, and the paths it names where it names any. */
export interface DestructiveCommand {
  /** What is about to happen, in the words a milestone listing shows. */
  note: string;
  /** The files it names. Empty means the working tree itself, as with `git reset --hard`. */
  operands: readonly string[];
}

/** Sources a single `mv` names before it counts as a mass move. */
export const MASS_MOVE_SOURCES = 3;

/** git's own options that take a value, skipped to find the subcommand. */
const GIT_VALUE_OPTIONS: readonly string[] = ['-C', '-c', '--git-dir', '--work-tree'];

const OPTION_AND_VALUE = 2;

const GLOB = /[*?[]/;

const DRY_RUN_FLAG = /^-[a-zA-Z]*n/;

const WORKTREE_FLAGS: readonly string[] = ['-W', '--worktree'];

const RECURSIVE_FLAG = /^-[a-zA-Z]*[rR]/;

function operandsOf(args: readonly string[]): string[] {
  const at = args.indexOf('--');
  const before = at === -1 ? args : args.slice(0, at);
  const after = at === -1 ? [] : args.slice(at + 1);
  return [...before.filter((arg) => !arg.startsWith('-')), ...after];
}

function removal(args: readonly string[]): DestructiveCommand | null {
  const operands = operandsOf(args);
  if (operands.length === 0) return null;
  const recursive = args.some((arg) => RECURSIVE_FLAG.test(arg) || arg === '--recursive');
  return { note: `before ${recursive ? 'rm -r' : 'rm'} ${operands.join(' ')}`, operands };
}

function massMove(args: readonly string[]): DestructiveCommand | null {
  const operands = operandsOf(args);
  const sources = operands.slice(0, -1);
  // A glob the shell has not expanded yet is as many files as it matches.
  const mass =
    sources.length >= MASS_MOVE_SOURCES || sources.some((source) => GLOB.test(source));
  if (!mass) return null;
  return { note: `before mv of ${sources.length} path(s)`, operands };
}

/** The subcommand and what follows it, past any `-C dir` or `-c key=value`. */
function gitSubcommand(args: readonly string[]): readonly string[] {
  let at = 0;
  while (at < args.length && (args[at] ?? '').startsWith('-')) {
    // An option that takes a value takes the next word with it.
    at += GIT_VALUE_OPTIONS.includes(args[at] ?? '') ? OPTION_AND_VALUE : 1;
  }
  return args.slice(at);
}

/** Every path, `.` included, is a tree-wide discard once `--` or a bare `.` names it. */
function discardsFiles(rest: readonly string[]): boolean {
  return rest.includes('--') || rest.includes('.') || rest.includes('-f');
}

function gitDestroys(args: readonly string[]): DestructiveCommand | null {
  const [subcommand, ...rest] = gitSubcommand(args);
  const tree = { operands: [] };
  if (subcommand === 'reset' && rest.includes('--hard'))
    return { note: 'before git reset --hard', ...tree };
  // `-n` is a dry run and deletes nothing.
  if (subcommand === 'clean' && !rest.some((arg) => DRY_RUN_FLAG.test(arg)))
    return { note: 'before git clean', ...tree };
  if (subcommand === 'checkout' && discardsFiles(rest))
    return { note: `before git checkout ${rest.join(' ')}`.trim(), ...tree };
  // Only the index is touched when every change is `--staged`.
  const indexOnly =
    rest.includes('--staged') && !rest.some((arg) => WORKTREE_FLAGS.includes(arg));
  if (subcommand === 'restore' && !indexOnly)
    return { note: `before git restore ${rest.join(' ')}`.trim(), ...tree };
  return null;
}

/** The command as argv, or null when it destroys nothing a milestone could keep. */
export function destructiveCommand(argv: readonly string[]): DestructiveCommand | null {
  const [binary, ...args] = argv;
  if (binary === undefined) return null;
  switch (basename(binary)) {
    case 'rm':
      return removal(args);
    case 'mv':
      return massMove(args);
    case 'git':
      return gitDestroys(args);
    default:
      return null;
  }
}

/** The first destructive command in a shell line, which is the one to keep a tree before. */
export function destructiveInLine(line: string): DestructiveCommand | null {
  for (const command of normalizeShellCommand(line).commands) {
    const found = destructiveCommand(splitCommandLine(command));
    if (found !== null) return found;
  }
  return null;
}
