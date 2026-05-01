import type { CodeGraph } from './code-graph';
import { MAX_BLAST_RADIUS_DEPTH, MAX_BLAST_RADIUS_NODES } from './code-graph.constants';

export interface BlastRadius {
  /** The action target as supplied by the caller. */
  target: string;
  /** The graph path it resolved to, or null when unknown/ambiguous. */
  resolvedPath: string | null;
  /** Files that transitively import the target, nearest first then alphabetical. */
  reached: string[];
  /** Files importing the target directly. */
  directImporters: string[];
  /** Deepest import hop walked. */
  depth: number;
  /** A traversal ceiling was hit, so `reached` is a lower bound. */
  truncated: boolean;
}

const EMPTY_RADIUS = (target: string): BlastRadius => ({
  target,
  resolvedPath: null,
  reached: [],
  directImporters: [],
  depth: 0,
  truncated: false,
});

/**
 * Reverse reachability: everything that would compile against a change to
 * `target`. Breadth-first so `depth` is the true shortest hop count, and bounded
 * by both depth and node count so a cyclic or enormous graph cannot stall a
 * decision — cycles terminate on the visited set regardless.
 */
export function computeBlastRadius(graph: CodeGraph, target: string): BlastRadius {
  const resolvedPath = graph.resolvePath(target);
  if (!resolvedPath) return EMPTY_RADIUS(target);

  const visited = new Set<string>([resolvedPath]);
  const reached: string[] = [];
  let frontier = [...graph.importersOf(resolvedPath)].sort();
  const directImporters = [...frontier];
  let depth = 0;
  let truncated = false;

  while (frontier.length > 0 && depth < MAX_BLAST_RADIUS_DEPTH) {
    depth += 1;
    const next: string[] = [];
    for (const path of frontier) {
      if (visited.has(path)) continue;
      visited.add(path);
      if (reached.length >= MAX_BLAST_RADIUS_NODES) {
        truncated = true;
        break;
      }
      reached.push(path);
      next.push(...graph.importersOf(path));
    }
    if (truncated) break;
    frontier = [...new Set(next)].sort();
  }

  if (frontier.length > 0 && depth >= MAX_BLAST_RADIUS_DEPTH) truncated = true;

  return { target, resolvedPath, reached, directImporters, depth, truncated };
}
