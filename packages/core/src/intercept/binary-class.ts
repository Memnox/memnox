/**
 * What one command line is asking for, read from argv rather than from a string. A
 * interceptor sees the arguments already split by the kernel, so there is nothing to parse
 * and nothing to be fooled by: quoting tricks live in shell strings, not in argv.
 */

import { verbTableNames } from '../verbs/tables';
import { TOOL_CLASS } from '../discovery/classify';
import { BROWSER_LAUNCHERS } from '../discovery/browser';

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
  const recursive = args.some((arg) => RECURSIVE_FORCE.includes(arg));
  const target = firstNonFlag(args);
  const atRoot = target !== undefined && ROOTS.includes(target);
  return {
    action: 'filesystem.delete',
    class: COMMAND_CLASS.DESTRUCTIVE,
    ...(target === undefined ? {} : { target }),
    because: atRoot
      ? 'a recursive delete at a filesystem root'
      : recursive
        ? 'a recursive, forced delete'
        : 'a delete',
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

function positionalArgs(args: readonly string[], valueFlags: Set<string>): string[] {
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
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
  /* `curl | sh` cannot be seen from argv — the pipe belongs to the shell that built
     it — so the shell interceptor is what catches that, and this names the destination. */
  return {
    action: 'http.request',
    class: COMMAND_CLASS.NETWORK,
    ...(host === undefined ? {} : { target: host }),
    because: `${binary} reaches ${host ?? 'the network'}`,
  };
}

const PACKAGE_INSTALL_VERBS = ['install', 'add', 'i', 'ci'];

function classifyPackageManager(binary: string, args: readonly string[]): BinaryVerdict {
  const verb = firstNonFlag(args);
  const installing = verb !== undefined && PACKAGE_INSTALL_VERBS.includes(verb);
  return {
    action: installing ? 'package.install' : 'shell.execute',
    class: installing ? COMMAND_CLASS.PACKAGE_INSTALL : COMMAND_CLASS.NORMAL,
    ...(args[1] === undefined ? {} : { target: args[1] }),
    because: installing
      ? `${binary} installs code that then runs on this machine`
      : `${binary} ${verb ?? ''}`.trim(),
  };
}

/** Git subcommands that change something somebody else can see. */
const GIT_REMOTE = ['push', 'fetch', 'pull', 'clone'];

function classifyGit(args: readonly string[]): BinaryVerdict {
  const sub = firstNonFlag(args);
  if (sub === undefined) {
    return { action: 'git.status', class: COMMAND_CLASS.NORMAL, because: 'git' };
  }

  const forced = args.some(
    (arg) => arg === '--force' || arg === '-f' || arg === '--force-with-lease',
  );
  const positional = args.filter((arg) => !arg.startsWith('-'));
  const target = positional.slice(1).join(' ');

  if (sub === 'push') {
    return {
      action: 'git.push',
      class: forced ? COMMAND_CLASS.DESTRUCTIVE : COMMAND_CLASS.NETWORK,
      ...(target === '' ? {} : { target }),
      because: forced
        ? 'a force push rewrites history somebody else may have pulled'
        : 'a push reaches the remote',
    };
  }
  if (sub === 'reset' && args.includes('--hard')) {
    return {
      action: 'git.reset',
      class: COMMAND_CLASS.DESTRUCTIVE,
      ...(target === '' ? {} : { target }),
      because: 'a hard reset discards work that was never committed',
    };
  }
  if (sub === 'clean' && args.some((arg) => arg.includes('f'))) {
    return {
      action: 'git.clean',
      class: COMMAND_CLASS.DESTRUCTIVE,
      because: 'a forced clean deletes untracked files with no undo',
    };
  }
  if (GIT_REMOTE.includes(sub)) {
    return {
      action: `git.${sub}`,
      class: COMMAND_CLASS.NETWORK,
      ...(target === '' ? {} : { target }),
      because: `git ${sub} reaches the remote`,
    };
  }
  return {
    action: `git.${sub}`,
    class: COMMAND_CLASS.NORMAL,
    ...(target === '' ? {} : { target }),
    because: `git ${sub}`,
  };
}

/**
 * Binaries whose whole job is to hand a file's contents to whoever asked, and the
 * arguments of theirs that are not files.
 *
 * Without these a `filesystem.read` rule matched nothing any seam ever produced: the
 * deny that `scan`, `explain` and `doctor` all promise about `~/.ssh/id_ed25519` was
 * written, registered, reported in force, and fired on nothing. `cat` is the command
 * an agent reaches for, so it is the one the rule has to see.
 *
 * They stay out of `CLASSIFIERS` on purpose. That map decides which wrappers go on
 * PATH, and putting `cat` behind a node process would tax every read an agent makes
 * for a gate the shell seam already applies. What skips the seams is the kernel
 * guard's job, which is what `doctor` has always said.
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

export function isReader(binary: string): boolean {
  return READERS.has(binary);
}

/**
 * Absolute, because a rule names an absolute path and a command names whatever was
 * convenient. `~` and `$HOME` are expanded and a relative path is resolved against the
 * directory the command ran in, so `cat .ssh/id_ed25519` and `cat ~/.ssh/id_ed25519`
 * reach the same rule rather than one of them slipping past it.
 */
function absolutePath(candidate: string, env: NodeJS.ProcessEnv): string {
  const home = env['HOME'] ?? env['USERPROFILE'];
  let path = candidate;
  if (home !== undefined) {
    if (path === '~') path = home;
    else if (path.startsWith('~/')) path = `${home}/${path.slice(2)}`;
    else if (path.startsWith('$HOME/')) path = `${home}/${path.slice(6)}`;
  }
  if (path.startsWith('/')) return path;

  const cwd = env['PWD'];
  if (cwd === undefined) return path;
  return `${cwd.replace(/\/$/, '')}/${path.replace(/^\.\//, '')}`;
}

export interface ReaderVerdict {
  action: string;
  /** A read, so nothing here ever takes a lease or reads as a conflict. */
  class: typeof TOOL_CLASS.READ;
  target?: string;
  /** Every file named, because a rule that only saw the first would miss
      `cat README ~/.ssh/id_ed25519` — which is one argument away from no gate at all. */
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

  const valueFlags = new Set(READER_VALUE_FLAGS[binary] ?? []);
  const positional = positionalArgs(args, valueFlags);
  /* `cp a b` writes to `b`, and the read that matters is the source — which is how a
     credential leaves a machine that denied `cat`. The destination is the last one. */
  const files =
    binary === 'cp'
      ? positional.slice(0, -1)
      : PATTERN_FIRST.has(binary)
        ? positional.slice(1)
        : positional;

  const targets = files.map((file) => absolutePath(file, env));
  const first = targets[0];
  return {
    action: 'filesystem.read',
    class: TOOL_CLASS.READ,
    ...(first === undefined ? {} : { target: first }),
    targets,
    because: `${binary} reads the file it is given`,
  };
}

type Classifier = (binary: string, args: readonly string[]) => BinaryVerdict;

/**
 * One row per binary the interceptor directory holds. A binary absent here is not interceptormed,
 * and what is not interceptormed is named rather than left to be assumed.
 */
const CLASSIFIERS: Readonly<Record<string, Classifier>> = {
  rm: (_binary, args) => classifyRm(args),
  dd: (_binary, args) => ({
    action: 'filesystem.write',
    class: COMMAND_CLASS.DESTRUCTIVE,
    ...(args.find((arg) => arg.startsWith('of=')) === undefined
      ? {}
      : { target: args.find((arg) => arg.startsWith('of=')) as string }),
    because: 'dd writes raw blocks and does not ask twice',
  }),
  curl: classifyCurl,
  wget: classifyCurl,
  ssh: (_binary, args) => ({
    action: 'network.ssh',
    class: COMMAND_CLASS.NETWORK,
    ...(firstNonFlag(args) === undefined ? {} : { target: firstNonFlag(args) as string }),
    because: 'ssh reaches another machine',
  }),
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
