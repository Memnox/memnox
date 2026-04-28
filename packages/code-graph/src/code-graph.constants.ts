/** Extensions probed, in order, when an import specifier omits one. */
export const RESOLVABLE_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rb',
  '.rs',
];

/** Basenames probed when a specifier resolves to a directory rather than a file. */
export const INDEX_BASENAMES: readonly string[] = ['index', '__init__', 'mod'];

/**
 * Traversal ceilings. A decision must never wait on an unbounded graph walk, so
 * reachability stops at these bounds and reports itself truncated instead.
 */
export const MAX_BLAST_RADIUS_DEPTH = 12;
export const MAX_BLAST_RADIUS_NODES = 2_000;

/** Reached-file count above which a change is flagged as unusually far-reaching. */
export const WIDE_REACH_FILE_THRESHOLD = 25;

export const LANGUAGE = {
  TYPESCRIPT: 'typescript',
  JAVASCRIPT: 'javascript',
  PYTHON: 'python',
  GO: 'go',
  RUBY: 'ruby',
  RUST: 'rust',
  JVM: 'jvm',
  UNKNOWN: 'unknown',
} as const;

export type Language = (typeof LANGUAGE)[keyof typeof LANGUAGE];

export const EXTENSION_LANGUAGES: Readonly<Record<string, Language>> = {
  '.ts': LANGUAGE.TYPESCRIPT,
  '.tsx': LANGUAGE.TYPESCRIPT,
  '.mts': LANGUAGE.TYPESCRIPT,
  '.cts': LANGUAGE.TYPESCRIPT,
  '.js': LANGUAGE.JAVASCRIPT,
  '.jsx': LANGUAGE.JAVASCRIPT,
  '.mjs': LANGUAGE.JAVASCRIPT,
  '.cjs': LANGUAGE.JAVASCRIPT,
  '.py': LANGUAGE.PYTHON,
  '.go': LANGUAGE.GO,
  '.rb': LANGUAGE.RUBY,
  '.rs': LANGUAGE.RUST,
  '.java': LANGUAGE.JVM,
  '.kt': LANGUAGE.JVM,
};

/** Snapshot format version — bumped when the serialized shape changes. */
export const CODE_GRAPH_SNAPSHOT_VERSION = 1;
