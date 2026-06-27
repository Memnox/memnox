import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import {
  CodeGraph,
  computeBlastRadius,
  type CodeGraphSnapshot,
} from '@memnox/code-graph';
import { DEFAULT_CODE_GRAPH_FILE } from '../defaults';
import { readRepoSources } from '../repo-walk';

async function loadGraph(filePath: string): Promise<CodeGraph> {
  const snapshot = JSON.parse(await readFile(filePath, 'utf8')) as CodeGraphSnapshot;
  return CodeGraph.fromSnapshot(snapshot);
}

export function registerGraphCommand(program: Command, context: CliContext): void {
  const graph = program
    .command('graph')
    .description('Build and query the import graph blast-radius escalation uses');

  graph
    .command('build [directory]')
    .description('Scan a repository and write a code-graph snapshot')
    .option('-o, --out <path>', 'snapshot output path', DEFAULT_CODE_GRAPH_FILE)
    .action(async (directory: string | undefined, options: { out: string }) => {
      const root = directory ?? process.cwd();
      const sources = await readRepoSources(root);
      if (sources.length === 0) {
        throw new Error(`no source files found under ${root}`);
      }

      const built = CodeGraph.build(sources);
      await mkdir(dirname(options.out), { recursive: true });
      await writeFile(
        options.out,
        JSON.stringify(built.toSnapshot(new Date().toISOString())),
        'utf8',
      );

      context.out.line(
        `Graphed ${built.fileCount} files, ${built.edgeCount} import edges → ${options.out}`,
      );
      context.out.line(
        `Next: memnox serve --code-graph ${options.out} --protected-path "*payment/*"`,
      );
    });

  graph
    .command('explain <file>')
    .description('Show what a change to a file transitively reaches')
    .option('-g, --graph <path>', 'snapshot path', DEFAULT_CODE_GRAPH_FILE)
    .action(async (file: string, options: { graph: string }) => {
      const radius = computeBlastRadius(await loadGraph(options.graph), file);

      if (!radius.resolvedPath) {
        context.out.line(`No unique match for "${file}" in the graph.`);
        return;
      }

      context.out.line(`File     : ${radius.resolvedPath}`);
      context.out.line(
        `Reaches  : ${radius.reached.length}${radius.truncated ? '+ (truncated)' : ''} files across ${radius.depth} hops`,
      );
      if (radius.reached.length === 0) {
        context.out.line('Nothing imports this file — changing it affects only itself.');
        return;
      }
      const directSet = new Set(radius.directImporters);
      for (const path of radius.reached) {
        context.out.line(`  ${directSet.has(path) ? 'direct  ' : 'indirect'}  ${path}`);
      }
    });
}
