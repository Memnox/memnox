import {
  INDEX_BASENAMES,
  LANGUAGE,
  RESOLVABLE_EXTENSIONS,
  type Language,
} from './code-graph.constants';
import { detectLanguage } from './language';

const SEGMENT_SEPARATOR = '/';
const CURRENT_DIR = '.';
const PARENT_DIR = '..';
const PY_LEVEL_MARKER = '.';
const RUST_PATH_SEPARATOR = '::';
const RUST_CRATE_ROOT = 'crate';
const RUST_SELF = 'self';
const RUST_SUPER = 'super';

function dirnameOf(filePath: string): string {
  const lastSlash = filePath.lastIndexOf(SEGMENT_SEPARATOR);
  return lastSlash < 0 ? '' : filePath.slice(0, lastSlash);
}

/** Collapses "." and ".." without touching the filesystem. Paths are repo-relative posix. */
function normalize(segments: readonly string[]): string {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === CURRENT_DIR) continue;
    if (segment === PARENT_DIR) {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join(SEGMENT_SEPARATOR);
}

function joinFrom(baseDir: string, relative: string): string {
  return normalize([
    ...baseDir.split(SEGMENT_SEPARATOR),
    ...relative.split(SEGMENT_SEPARATOR),
  ]);
}

/** Every path a bare specifier could mean, in resolution order. */
function candidatesFor(base: string): string[] {
  const candidates = [base];
  for (const extension of RESOLVABLE_EXTENSIONS) candidates.push(`${base}${extension}`);
  for (const indexName of INDEX_BASENAMES) {
    for (const extension of RESOLVABLE_EXTENSIONS) {
      candidates.push(`${base}${SEGMENT_SEPARATOR}${indexName}${extension}`);
    }
  }
  return candidates;
}

/** "..pkg.mod" → one directory up, then "pkg/mod". Leading dot count is the level. */
function pythonBase(fromFile: string, specifier: string): string {
  let level = 0;
  while (specifier[level] === PY_LEVEL_MARKER) level += 1;
  const remainder = specifier.slice(level).split(PY_LEVEL_MARKER).filter(Boolean);
  const upward = Array.from({ length: Math.max(0, level - 1) }, () => PARENT_DIR);
  return normalize([
    ...dirnameOf(fromFile).split(SEGMENT_SEPARATOR),
    ...upward,
    ...remainder,
  ]);
}

/** "crate::a::b" is repo-root relative; "self::"/"super::" are relative to the file. */
function rustBase(fromFile: string, specifier: string): string | null {
  const segments = specifier
    .split(RUST_PATH_SEPARATOR)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const [head, ...rest] = segments;
  if (!head) return null;
  const usable = rest.filter((segment) => !segment.startsWith('{') && segment !== '*');
  if (head === RUST_CRATE_ROOT) return normalize(usable);
  if (head === RUST_SELF)
    return joinFrom(dirnameOf(fromFile), usable.join(SEGMENT_SEPARATOR));
  if (head === RUST_SUPER) {
    return normalize([
      ...dirnameOf(fromFile).split(SEGMENT_SEPARATOR),
      PARENT_DIR,
      ...usable,
    ]);
  }
  return null;
}

/**
 * Resolves an import specifier to a path in `knownPaths`, or null when it points
 * outside the repo (a package) or cannot be matched. Resolution is pure: the only
 * evidence used is the set of paths the graph was built from.
 */
export function resolveSpecifier(
  fromFile: string,
  specifier: string,
  knownPaths: ReadonlySet<string>,
): string | null {
  const language: Language = detectLanguage(fromFile);

  let base: string | null;
  if (language === LANGUAGE.PYTHON && specifier.startsWith(PY_LEVEL_MARKER)) {
    base = pythonBase(fromFile, specifier);
  } else if (language === LANGUAGE.RUST) {
    base = rustBase(fromFile, specifier);
  } else if (specifier.startsWith(CURRENT_DIR)) {
    base = joinFrom(dirnameOf(fromFile), specifier);
  } else if (specifier.startsWith(SEGMENT_SEPARATOR)) {
    base = normalize(specifier.split(SEGMENT_SEPARATOR));
  } else {
    return null;
  }

  if (base === null) return null;
  for (const candidate of candidatesFor(base)) {
    if (knownPaths.has(candidate)) return candidate;
  }
  return null;
}
