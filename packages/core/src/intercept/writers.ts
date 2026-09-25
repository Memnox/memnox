/**
 * The files a command writes, which is how `sed -i`, `mv` and `tee` change a file that no
 * reader or `rm` rule would ever see.
 */
import { TOOL_CLASS } from '../discovery/classify';
import { ACTION } from '../constants/action.constants';
import { absolutePath, positionalArgs } from './binary-class';

export interface WriterVerdict {
  action: string;
  class: typeof TOOL_CLASS.WRITE | typeof TOOL_CLASS.DESTRUCTIVE;
  target?: string;
  /** Every file written, so a rule on the second path of `touch a ~/.bashrc` is reached. */
  targets: readonly string[];
  because: string;
}

/** Writers' flags that take a value, so the value is never read as a file. */
const WRITER_VALUE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  truncate: ['-s', '--size', '-r', '--reference'],
  install: ['-m', '--mode', '-o', '--owner', '-g', '--group', '-t', '--target-directory'],
  sed: ['-e', '--expression', '-f', '--file'],
  mkdir: ['-m', '--mode'],
  ln: ['-t', '--target-directory'],
  mv: ['-t', '--target-directory', '-S', '--suffix'],
  cp: ['-t', '--target-directory', '-S', '--suffix'],
};

/** Removers that `rm` is not, which delete what they are given just the same. */
const REMOVERS = new Set(['rmdir', 'unlink', 'shred']);

/** Null when this binary writes no file it names. */
export function classifyWriter(
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): WriterVerdict | null {
  const written = filesWrittenBy(binary, args);
  if (written === null) return null;
  const targets = written.map((file) => absolutePath(file, env));
  const first = targets[0];
  const removes = REMOVERS.has(binary);
  return {
    action: removes ? ACTION.FILESYSTEM_DELETE : ACTION.FILESYSTEM_WRITE,
    class: removes ? TOOL_CLASS.DESTRUCTIVE : TOOL_CLASS.WRITE,
    ...(first === undefined ? {} : { target: first }),
    targets,
    because: removes
      ? `${binary} deletes what it is given`
      : `${binary} writes ${first ?? 'a file'}`,
  };
}

function filesWrittenBy(binary: string, args: readonly string[]): string[] | null {
  const positional = positionalArgs(args, new Set(WRITER_VALUE_FLAGS[binary] ?? []));
  const targetDirectory = valueOf(args, ['-t', '--target-directory']);
  switch (binary) {
    case 'touch':
    case 'mkdir':
    case 'tee':
    case 'truncate':
      return positional;
    case 'rmdir':
    case 'unlink':
    case 'shred':
      return positional;
    // The source goes too, so both ends of a move are written.
    case 'mv':
      return targetDirectory === undefined
        ? positional
        : [...positional, targetDirectory];
    case 'cp':
    case 'install':
    case 'ln': {
      if (targetDirectory !== undefined) return [targetDirectory];
      const last = positional[positional.length - 1];
      // `ln -s target` makes its link in the working directory.
      if (binary === 'ln' && positional.length === 1) return ['.'];
      return last === undefined || positional.length < 2 ? [] : [last];
    }
    case 'chmod':
    case 'chown':
    case 'chgrp':
      // The first positional is the mode or the owner, not a file.
      return positional.slice(1);
    case 'sed':
    case 'gsed':
      return sedInPlaceFiles(args, positional);
    default:
      return null;
  }
}

function valueOf(args: readonly string[], flags: readonly string[]): string | undefined {
  for (const [index, arg] of args.entries()) {
    if (flags.includes(arg)) return args[index + 1];
    const inline = flags.find(
      (flag) => flag.startsWith('--') && arg.startsWith(`${flag}=`),
    );
    if (inline !== undefined) return arg.slice(inline.length + 1);
  }
  return undefined;
}

/** `sed -i` edits the files it is given; without it sed only prints. */
function sedInPlaceFiles(
  args: readonly string[],
  positional: readonly string[],
): string[] | null {
  const inPlace = args.some(
    (arg) => arg === '-I' || arg.startsWith('--in-place') || /^-[a-zA-Z]*i/.test(arg),
  );
  if (!inPlace) return null;
  // BSD sed takes `-i ''` for no backup, which is an empty word rather than a file.
  const files = positional.filter((arg) => arg !== '');
  // With no `-e` or `-f`, the first positional is the script.
  const scripted = args.some((arg) =>
    ['-e', '--expression', '-f', '--file'].includes(arg),
  );
  return scripted ? files : files.slice(1);
}
