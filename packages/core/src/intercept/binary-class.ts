/**
 * What one command line is asking for, read from argv rather than from a string. An
 * interceptor sees arguments the kernel already split, so no quoting trick can fool it.
 */
import { verbTableNames } from '../verbs/tables';
import { TOOL_CLASS } from '../discovery/classify';
import { BROWSER_LAUNCHERS } from '../discovery/browser';
import { ACTION, HTTP_METHOD } from '../constants/action.constants';

export const COMMAND_CLASS = {
  NORMAL: 'normal',
  DESTRUCTIVE: 'destructive',
  NETWORK: 'network',
  PACKAGE_INSTALL: 'package-install',
} as const;

export type CommandClass = (typeof COMMAND_CLASS)[keyof typeof COMMAND_CLASS];

export interface BinaryVerdict {
  /** The namespaced action a rule is written about. */
  action: string;
  class: CommandClass;
  /** What it operates on: a path, a host, a branch. Never the whole line. */
  target?: string;
  /** Why this class, in the words the refusal will use. */
  because: string;
  /** The HTTP method a request uses, so a rule can let a read through and ask about a change. */
  method?: string;
}

/** Flags that turn a survivable command into an unsurvivable one. */
const RECURSIVE_FORCE = ['-rf', '-fr', '-Rf', '-fR', '--recursive'];
const ROOTS = ['/', '/*', '~', '~/', '.', './'];

function firstNonFlag(args: readonly string[]): string | undefined {
  return args.find((arg) => !arg.startsWith('-'));
}

function hostOf(candidate: string): string | undefined {
  try {
    return new URL(candidate).host;
  } catch {
    // Not a URL: curl also takes bare hosts, which are still the target.
    return /^[\w.-]+\.[a-z]{2,}/i.test(candidate) ? candidate.split('/')[0] : undefined;
  }
}

function classifyRm(args: readonly string[]): BinaryVerdict {
  const target = firstNonFlag(args);
  return {
    action: ACTION.FILESYSTEM_DELETE,
    class: COMMAND_CLASS.DESTRUCTIVE,
    ...(target === undefined ? {} : { target }),
    because: describeRm(args, target),
  };
}

function describeRm(args: readonly string[], target: string | undefined): string {
  if (target !== undefined && ROOTS.includes(target)) {
    return 'a recursive delete at a filesystem root';
  }
  if (args.some((arg) => RECURSIVE_FORCE.includes(arg)))
    return 'a recursive, forced delete';
  return 'a delete';
}

function classifyDd(args: readonly string[]): BinaryVerdict {
  const output = args.find((arg) => arg.startsWith('of='));
  return {
    action: ACTION.FILESYSTEM_WRITE,
    class: COMMAND_CLASS.DESTRUCTIVE,
    ...(output === undefined ? {} : { target: output }),
    because: 'dd writes raw blocks and does not ask twice',
  };
}

function classifySsh(args: readonly string[]): BinaryVerdict {
  const host = firstNonFlag(args);
  return {
    action: 'network.ssh',
    class: COMMAND_CLASS.NETWORK,
    ...(host === undefined ? {} : { target: host }),
    because: 'ssh reaches another machine',
  };
}

/**
 * Flags whose value is a separate argument. Without this the value of `-H` reads as a
 * positional, and the "target" recorded for a curl becomes somebody's bearer token.
 */
const CURL_VALUE_FLAGS = new Set([
  '-H',
  '--header',
  '-d',
  '--data',
  '-o',
  '--output',
  '-u',
  '--user',
  '-A',
  '--user-agent',
  '-b',
  '--cookie',
  '-e',
  '--referer',
  '-X',
  '--request',
  '-F',
  '--form',
  '-T',
  '--upload-file',
]);

function positionalArgs(
  args: readonly string[],
  valueFlags: ReadonlySet<string>,
): string[] {
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    // Inside the bounds the loop checks, so never undefined.
    const arg = args[index] as string;
    if (valueFlags.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    positional.push(arg);
  }
  return positional;
}

function classifyCurl(binary: string, args: readonly string[]): BinaryVerdict {
  const candidates = positionalArgs(args, CURL_VALUE_FLAGS);
  const host = candidates.map(hostOf).find((each) => each !== undefined);
  // `curl | sh` is invisible in argv because the shell owns the pipe, so this names the destination.
  return {
    action: ACTION.HTTP_REQUEST,
    class: COMMAND_CLASS.NETWORK,
    ...(host === undefined ? {} : { target: host }),
    because: `${binary} reaches ${host ?? 'the network'}`,
    method: requestMethodOf(args),
  };
}

/** Flags that name the method outright, as `-X POST` or `--method=PUT`. */
const METHOD_FLAGS: readonly string[] = ['-X', '--request', '--method'];

/** Flags that send a body, which a request only does to change something. */
const BODY_FLAGS: readonly string[] = [
  '-d',
  '--data',
  '--data-raw',
  '--data-binary',
  '--data-urlencode',
  '--json',
  '-F',
  '--form',
  '-T',
  '--upload-file',
  '--post-data',
  '--post-file',
  '--body-data',
  '--body-file',
];

const HEAD_FLAGS: readonly string[] = ['-I', '--head', '--spider'];

const GET_FLAGS: readonly string[] = ['-G', '--get'];

/**
 * The method a `curl` or `wget` line uses: the one it names, POST where it sends a body
 * without naming one, HEAD for a look at the headers, and GET otherwise.
 */
export function requestMethodOf(args: readonly string[]): string {
  const named = namedMethod(args);
  if (named !== null) return named.toUpperCase();
  // `curl -G -d q=x` puts the data in the query string, so it stays a read.
  if (args.some((arg) => GET_FLAGS.includes(arg))) return HTTP_METHOD.GET;
  if (args.some((arg) => BODY_FLAGS.includes(arg) || carriesBody(arg)))
    return HTTP_METHOD.POST;
  if (args.some((arg) => HEAD_FLAGS.includes(arg))) return HTTP_METHOD.HEAD;
  return HTTP_METHOD.GET;
}

function namedMethod(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    // Inside the bounds the loop checks, so never undefined.
    const arg = args[index] as string;
    if (METHOD_FLAGS.includes(arg)) return args[index + 1] ?? null;
    const inline = METHOD_FLAGS.find((flag) => arg.startsWith(`${flag}=`));
    if (inline !== undefined) return arg.slice(inline.length + 1);
    // `-XPOST`, the short flag with its value run on.
    if (arg.startsWith('-X') && arg.length > 2) return arg.slice(2);
  }
  return null;
}

/** `--data=...` and `-dvalue`, which carry the body in the flag itself. */
function carriesBody(arg: string): boolean {
  if (BODY_FLAGS.some((flag) => flag.startsWith('--') && arg.startsWith(`${flag}=`)))
    return true;
  return arg.length > 2 && arg.startsWith('-d') && !arg.startsWith('--');
}

const PACKAGE_INSTALL_VERBS = ['install', 'add', 'i', 'ci'];

function classifyPackageManager(binary: string, args: readonly string[]): BinaryVerdict {
  const verb = firstNonFlag(args);
  const installing = verb !== undefined && PACKAGE_INSTALL_VERBS.includes(verb);
  return {
    action: installing ? 'package.install' : ACTION.SHELL_EXECUTE,
    class: installing ? COMMAND_CLASS.PACKAGE_INSTALL : COMMAND_CLASS.NORMAL,
    ...(args[1] === undefined ? {} : { target: args[1] }),
    because: installing
      ? `${binary} installs code that then runs on this machine`
      : `${binary} ${verb ?? ''}`.trim(),
  };
}

/** Git subcommands that change something somebody else can see. */
const GIT_REMOTE = ['push', 'fetch', 'pull', 'clone'];

const FORCE_FLAGS = ['--force', '-f', '--force-with-lease'];

/** Git's own flags that take a value, so the value is never read as the subcommand. */
const GIT_VALUE_FLAGS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
]);

function classifyGit(args: readonly string[]): BinaryVerdict {
  // Skips flag values, so `git -C <path> diff` is a diff rather than an action named for the path.
  const subcommand = firstNonFlag(positionalArgs(args, GIT_VALUE_FLAGS));
  if (subcommand === undefined) {
    return { action: 'git.status', class: COMMAND_CLASS.NORMAL, because: 'git' };
  }
  const positional = args.filter((arg) => !arg.startsWith('-'));
  const target = positional.slice(1).join(' ');
  const verdict = classifyGitSubcommand(subcommand, args);
  // A forced clean names no target, since what it deletes is whatever is untracked.
  if (target === '' || verdict.action === 'git.clean') return verdict;
  return { ...verdict, target };
}

function classifyGitSubcommand(
  subcommand: string,
  args: readonly string[],
): BinaryVerdict {
  const destructive = destructiveGitVerdict(subcommand, args);
  if (destructive !== null) return destructive;
  if (subcommand === 'push') {
    return {
      action: 'git.push',
      class: COMMAND_CLASS.NETWORK,
      because: 'a push reaches the remote',
    };
  }
  if (GIT_REMOTE.includes(subcommand)) {
    return {
      action: `git.${subcommand}`,
      class: COMMAND_CLASS.NETWORK,
      because: `git ${subcommand} reaches the remote`,
    };
  }
  return {
    action: `git.${subcommand}`,
    class: COMMAND_CLASS.NORMAL,
    because: `git ${subcommand}`,
  };
}

/** A force push, a hard reset or a forced clean: the git commands with no undo. */
function destructiveGitVerdict(
  subcommand: string,
  args: readonly string[],
): BinaryVerdict | null {
  if (subcommand === 'push' && args.some((arg) => FORCE_FLAGS.includes(arg))) {
    return {
      action: 'git.push',
      class: COMMAND_CLASS.DESTRUCTIVE,
      because: 'a force push rewrites history somebody else may have pulled',
    };
  }
  if (subcommand === 'reset' && args.includes('--hard')) {
    return {
      action: 'git.reset',
      class: COMMAND_CLASS.DESTRUCTIVE,
      because: 'a hard reset discards work that was never committed',
    };
  }
  if (subcommand === 'clean' && args.some((arg) => arg.includes('f'))) {
    return {
      action: 'git.clean',
      class: COMMAND_CLASS.DESTRUCTIVE,
      because: 'a forced clean deletes untracked files with no undo',
    };
  }
  return null;
}

/**
 * Readers' flags that take a value, so a `filesystem.read` rule fires on the files. Kept out
 * of `CLASSIFIERS`, which decides what goes on PATH, because the shell seam already gates reads.
 */
const READER_VALUE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  head: ['-n', '-c', '--lines', '--bytes'],
  tail: ['-n', '-c', '--lines', '--bytes'],
  grep: ['-e', '-f', '-m', '--regexp', '--file'],
  rg: ['-e', '-f', '-m', '--regexp', '--file'],
  od: ['-N', '-j', '-t'],
  xxd: ['-l', '-s', '-c'],
};

/** Readers whose leading positional is not a file: `grep <pattern> <file...>`. */
const PATTERN_FIRST = new Set(['grep', 'rg']);

const READERS = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'nl',
  'tac',
  'strings',
  'xxd',
  'od',
  'base64',
  'grep',
  'rg',
  'cp',
]);

/**
 * Absolute, because a rule names an absolute path and a command names whatever was
 * convenient, so `cat .ssh/id_ed25519` and `cat ~/.ssh/id_ed25519` reach one rule.
 */
function absolutePath(candidate: string, env: NodeJS.ProcessEnv): string {
  const path = withHomeExpanded(candidate, env['HOME'] ?? env['USERPROFILE']);
  if (path.startsWith('/')) return path;

  const cwd = env['PWD'];
  if (cwd === undefined) return path;
  return `${cwd.replace(/\/$/, '')}/${path.replace(/^\.\//, '')}`;
}

const HOME_PREFIXES = ['~/', '$HOME/'];

function withHomeExpanded(path: string, home: string | undefined): string {
  if (home === undefined) return path;
  if (path === '~') return home;
  const prefix = HOME_PREFIXES.find((each) => path.startsWith(each));
  return prefix === undefined ? path : `${home}/${path.slice(prefix.length)}`;
}

export interface ReaderVerdict {
  action: string;
  /** A read, so nothing here ever takes a lease or reads as a conflict. */
  class: typeof TOOL_CLASS.READ;
  target?: string;
  /** Every file named, because a rule that only saw the first would miss `cat README ~/.ssh/id_ed25519`. */
  targets: readonly string[];
  because: string;
}

/** Null when this binary does not read files for a living. */
export function classifyReader(
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): ReaderVerdict | null {
  if (!READERS.has(binary)) return null;

  const targets = filesReadBy(binary, args).map((file) => absolutePath(file, env));
  const first = targets[0];
  return {
    action: ACTION.FILESYSTEM_READ,
    class: TOOL_CLASS.READ,
    ...(first === undefined ? {} : { target: first }),
    targets,
    because: `${binary} reads the file it is given`,
  };
}

function filesReadBy(binary: string, args: readonly string[]): string[] {
  const positional = positionalArgs(args, new Set(READER_VALUE_FLAGS[binary] ?? []));
  // `cp a b` reads `a`, which is how a credential leaves a machine that denied `cat`.
  if (binary === 'cp') return positional.slice(0, -1);
  if (PATTERN_FIRST.has(binary)) return positional.slice(1);
  return positional;
}

type Classifier = (binary: string, args: readonly string[]) => BinaryVerdict;

/**
 * One row per binary the interceptor directory holds. A binary absent here is not
 * intercepted, and what is not intercepted is named rather than left to be assumed.
 */
const CLASSIFIERS: Readonly<Record<string, Classifier>> = {
  rm: (_binary, args) => classifyRm(args),
  dd: (_binary, args) => classifyDd(args),
  curl: classifyCurl,
  wget: classifyCurl,
  ssh: (_binary, args) => classifySsh(args),
  git: (_binary, args) => classifyGit(args),
  npm: classifyPackageManager,
  pnpm: classifyPackageManager,
  yarn: classifyPackageManager,
  pip: classifyPackageManager,
  pip3: classifyPackageManager,
};

export function interceptedBinaries(): readonly string[] {
  return Object.keys(CLASSIFIERS);
}

/**
 * Every binary this runtime has an opinion about: the generic classifiers plus every
 * CLI with a verb table. `protect --for gh` writes rules named `gh.pr-merge`, and a
 * rule with nothing on PATH to intercept is a rule that cannot fire.
 */
export function interceptableBinaries(): readonly string[] {
  return [
    ...new Set([...Object.keys(CLASSIFIERS), ...verbTableNames(), ...BROWSER_LAUNCHERS]),
  ];
}

export function isIntercepted(binary: string): boolean {
  return CLASSIFIERS[binary] !== undefined;
}

/** Null when this binary is not one the interceptor directory holds. */
export function classifyBinary(
  binary: string,
  args: readonly string[],
): BinaryVerdict | null {
  const classifier = CLASSIFIERS[binary];
  if (classifier === undefined) return null;
  return classifier(binary, args);
}
