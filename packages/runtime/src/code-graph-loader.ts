import { readFile } from 'node:fs/promises';
import { CodeGraph, type CodeGraphSnapshot } from '@memnox/code-graph';
import type { Logger } from '@memnox/core';

/**
 * Loads a snapshot written by `memnox graph build`. A missing or unreadable
 * snapshot logs and yields null: blast radius is an escalation-only signal, so
 * its absence must not stop the runtime from starting.
 */
export async function loadCodeGraphFromFile(
  filePath: string,
  logger: Logger,
): Promise<CodeGraph | null> {
  try {
    const snapshot = JSON.parse(await readFile(filePath, 'utf8')) as CodeGraphSnapshot;
    const graph = CodeGraph.fromSnapshot(snapshot);
    logger.info(
      `code graph loaded: ${graph.fileCount} files, ${graph.edgeCount} import edges`,
    );
    return graph;
  } catch (error) {
    logger.warn(`code graph unavailable (${filePath}): ${String(error)}`);
    return null;
  }
}
