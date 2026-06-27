import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { GraphSource } from '@memnox/code-graph';
import { detectLanguage, LANGUAGE } from '@memnox/code-graph';

/** Directories never worth graphing — vendored code, build output, VCS metadata. */
const IGNORED_DIRECTORIES: readonly string[] = [
  '.git',
  '.memnox',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.next',
  '.turbo',
];

/** Files above this size are skipped: generated bundles, not hand-written source. */
const MAX_SOURCE_FILE_BYTES = 1_000_000;

const POSIX_SEPARATOR = '/';

/** Repo-relative posix path, so a graph built on Windows matches one built on Linux. */
function toPosix(path: string): string {
  return path.split(sep).join(POSIX_SEPARATOR);
}

async function collectPaths(
  root: string,
  current: string,
  into: string[],
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.includes(entry.name)) continue;
      await collectPaths(root, absolute, into);
      continue;
    }
    if (!entry.isFile()) continue;
    if (detectLanguage(entry.name) === LANGUAGE.UNKNOWN) continue;
    into.push(absolute);
  }
}

/** Reads every source file under `root` that the graph can parse. */
export async function readRepoSources(root: string): Promise<GraphSource[]> {
  const absolutePaths: string[] = [];
  await collectPaths(root, root, absolutePaths);

  const sources: GraphSource[] = [];
  for (const absolute of absolutePaths) {
    const info = await stat(absolute);
    if (info.size > MAX_SOURCE_FILE_BYTES) continue;
    sources.push({
      path: toPosix(relative(root, absolute)),
      content: await readFile(absolute, 'utf8'),
    });
  }
  return sources.sort((a, b) => a.path.localeCompare(b.path));
}
