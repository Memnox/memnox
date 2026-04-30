import { CODE_GRAPH_SNAPSHOT_VERSION } from './code-graph.constants';
import { extractImports } from './imports';
import { resolveSpecifier } from './module-resolver';

export interface GraphSource {
  /** Repo-relative posix path. */
  path: string;
  content: string;
}

/** Index-based edges keep a whole-repo snapshot small enough to load on every boot. */
export interface CodeGraphSnapshot {
  version: number;
  /** Stamped by the writer, never read during a decision. */
  builtAt?: string;
  files: string[];
  edges: Array<[number, number]>;
}

const PATH_SEPARATOR = '/';

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * A file-level import graph. Reachability is computed over imports only —
 * regex-derived call edges are too imprecise to justify escalating on, so the
 * graph deliberately answers the narrower question it can answer reliably.
 */
export class CodeGraph {
  private readonly forward: ReadonlyMap<string, readonly string[]>;
  private readonly reverse: ReadonlyMap<string, readonly string[]>;

  private constructor(
    private readonly filePaths: readonly string[],
    forward: Map<string, string[]>,
    reverse: Map<string, string[]>,
  ) {
    this.forward = forward;
    this.reverse = reverse;
  }

  static build(sources: readonly GraphSource[]): CodeGraph {
    const knownPaths = new Set(sources.map((source) => source.path));
    const forward = new Map<string, string[]>();
    const reverse = new Map<string, string[]>();

    for (const source of sources) {
      const targets: string[] = [];
      for (const dependency of extractImports(source.path, source.content)) {
        if (!dependency.internal) continue;
        const resolved = resolveSpecifier(source.path, dependency.specifier, knownPaths);
        if (!resolved || resolved === source.path) continue;
        targets.push(resolved);
      }
      forward.set(source.path, sortedUnique(targets));
    }

    for (const [from, targets] of forward) {
      for (const target of targets) {
        const importers = reverse.get(target);
        if (importers) importers.push(from);
        else reverse.set(target, [from]);
      }
    }
    for (const [target, importers] of reverse)
      reverse.set(target, sortedUnique(importers));

    return new CodeGraph(sortedUnique(knownPaths), forward, reverse);
  }

  static fromSnapshot(snapshot: CodeGraphSnapshot): CodeGraph {
    if (snapshot.version !== CODE_GRAPH_SNAPSHOT_VERSION) {
      throw new Error(
        `unsupported code graph snapshot version ${snapshot.version}, expected ${CODE_GRAPH_SNAPSHOT_VERSION}`,
      );
    }
    const forward = new Map<string, string[]>();
    const reverse = new Map<string, string[]>();
    for (const path of snapshot.files) forward.set(path, []);

    for (const [fromIndex, toIndex] of snapshot.edges) {
      const from = snapshot.files[fromIndex];
      const to = snapshot.files[toIndex];
      if (from === undefined || to === undefined) continue;
      const targets = forward.get(from);
      if (targets) targets.push(to);
      else forward.set(from, [to]);

      const importers = reverse.get(to);
      if (importers) importers.push(from);
      else reverse.set(to, [from]);
    }
    for (const [from, targets] of forward) forward.set(from, sortedUnique(targets));
    for (const [to, importers] of reverse) reverse.set(to, sortedUnique(importers));

    return new CodeGraph(sortedUnique(snapshot.files), forward, reverse);
  }

  toSnapshot(builtAt?: string): CodeGraphSnapshot {
    const indexOf = new Map(this.filePaths.map((path, index) => [path, index]));
    const edges: Array<[number, number]> = [];
    for (const from of this.filePaths) {
      const fromIndex = indexOf.get(from);
      if (fromIndex === undefined) continue;
      for (const to of this.forward.get(from) ?? []) {
        const toIndex = indexOf.get(to);
        if (toIndex !== undefined) edges.push([fromIndex, toIndex]);
      }
    }
    return {
      version: CODE_GRAPH_SNAPSHOT_VERSION,
      ...(builtAt ? { builtAt } : {}),
      files: [...this.filePaths],
      edges,
    };
  }

  get files(): readonly string[] {
    return this.filePaths;
  }

  get fileCount(): number {
    return this.filePaths.length;
  }

  get edgeCount(): number {
    let total = 0;
    for (const targets of this.forward.values()) total += targets.length;
    return total;
  }

  has(path: string): boolean {
    return this.forward.has(path);
  }

  importsOf(path: string): readonly string[] {
    return this.forward.get(path) ?? [];
  }

  importersOf(path: string): readonly string[] {
    return this.reverse.get(path) ?? [];
  }

  /**
   * Maps an action target onto a graph path: exact match first, then a unique
   * path ending in the target. Ambiguous suffixes resolve to null — guessing
   * between two candidates would attribute a blast radius to the wrong file.
   */
  resolvePath(target: string): string | null {
    if (this.has(target)) return target;
    const suffix = target.startsWith(PATH_SEPARATOR)
      ? target
      : `${PATH_SEPARATOR}${target}`;
    const matches = this.filePaths.filter((path) => path.endsWith(suffix));
    return matches.length === 1 ? (matches[0] ?? null) : null;
  }
}
