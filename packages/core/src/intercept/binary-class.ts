/**
 * What one command line is asking for, read from argv rather than from a string. A
 * interceptor sees the arguments already split by the kernel, so there is nothing to parse
 * and nothing to be fooled by: quoting tricks live in shell strings, not in argv.
 */

import { verbTableNames } from '../verbs/tables';

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
  return [...new Set([...Object.keys(CLASSIFIERS), ...verbTableNames()])];
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
