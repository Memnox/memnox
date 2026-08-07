import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import { graphifyToSnapshot, isGraphifyDocument } from '@memnox/code-graph';
import type { CliContext } from '../cli-context';
import { DEFAULT_CODE_GRAPH_FILE } from '../defaults';
import {
  buildGraphifyGraph,
  GRAPHIFY_OUTPUT,
  GRAPHIFY_PACKAGE,
  graphifyVersion,
  installGraphify,
  processRunner,
  type CommandRunner,
} from '../graphify-runner';

const DEFAULT_OUT = DEFAULT_CODE_GRAPH_FILE;

const INSTALL_HELP = `Install it with:  uv tool install ${GRAPHIFY_PACKAGE}   (or pipx install ${GRAPHIFY_PACKAGE})`;

/**
 * `memnox graphify` — Graphify as Memnox's code-understanding backend.
 *
 * Graphify parses 36 languages with tree-sitter and emits `calls` and
 * `inherits` alongside imports. Memnox's own walker sees `import` statements in
 * a handful of languages, so it under-reports what a change reaches. Only
 * `EXTRACTED` (AST) edges are read — model-inferred ones never reach a decision.
 */
export function registerGraphifyCommand(
  program: Command,
  context: CliContext,
  runner: CommandRunner = processRunner,
  cwd: () => string = () => process.cwd(),
): void {
  const graphify = program
    .command('graphify')
    .description('Use Graphify to understand this codebase (deeper blast radius)');

  graphify
    .command('status')
    .description('Is Graphify installed, and is there a graph to read')
    .action(async () => {
      const { out } = context;
      const version = graphifyVersion(runner);
      out.line(`Graphify : ${version ?? 'not installed'}`);

      const graph = await readGraphify(cwd());
      out.line(
        `Graph    : ${graph === null ? `none at ${GRAPHIFY_OUTPUT}` : `${graph.snapshot.files.length} files, ${graph.edgeCount} edges`}`,
      );

      out.note('');
      if (version === null) out.note(`→ ${INSTALL_HELP}`);
      else if (graph === null) out.note('→ Build one:  memnox graphify build');
      else out.note('→ Use it:     memnox graphify use');
    });

  graphify
    .command('install')
    .description(`Install Graphify (${GRAPHIFY_PACKAGE}) with uv, pipx, or pip`)
    .action(() => {
      const { out } = context;
      const existing = graphifyVersion(runner);
      if (existing !== null) {
        out.line(`Graphify is already installed (${existing}).`);
        return;
      }

      const outcome = installGraphify(runner);
      if (!outcome.installed) {
        throw new Error(
          outcome.attempted.length === 0
            ? `No Python installer found (looked for uv, pipx, pip3). ${INSTALL_HELP}`
            : `Install failed via ${outcome.attempted.join(', ')}. ${INSTALL_HELP}`,
        );
      }
      out.line(`Installed ${GRAPHIFY_PACKAGE} via ${outcome.via ?? 'unknown'}.`);
      out.note('');
      out.note('→ Build the graph:  memnox graphify build');
    });

  graphify
    .command('build [directory]')
    .description('Re-extract the code graph (AST only — no LLM, no network)')
    .action(async (directory: string | undefined) => {
      const { out } = context;
      if (graphifyVersion(runner) === null) {
        throw new Error(`Graphify is not installed. ${INSTALL_HELP}`);
      }

      const root = directory ?? cwd();
      if (!buildGraphifyGraph(runner, root)) {
        throw new Error(`Graphify could not build a graph for ${root}.`);
      }

      const graph = await readGraphify(root);
      if (graph === null) {
        throw new Error(`Graphify reported success but wrote no ${GRAPHIFY_OUTPUT}.`);
      }
      out.line(
        `Graph: ${graph.snapshot.files.length} files, ${graph.edgeCount} edges` +
          (graph.inferredSkipped > 0
            ? ` (${graph.inferredSkipped} inferred edge(s) skipped)`
            : ''),
      );
      out.note('');
      out.note('→ Point the runtime at it:  memnox graphify use');
    });

  graphify
    .command('use [directory]')
    .description('Convert the Graphify graph into the snapshot the runtime reads')
    .option('-o, --out <path>', 'snapshot output path', DEFAULT_OUT)
    .action(async (directory: string | undefined, options: { out: string }) => {
      const { out } = context;
      const graph = await readGraphify(directory ?? cwd());
      if (graph === null) {
        throw new Error(
          `No ${GRAPHIFY_OUTPUT} here. Build one with:  memnox graphify build`,
        );
      }

      await writeSnapshot(options.out, graph.snapshot);
      out.line(
        `Wrote ${options.out} — ${graph.snapshot.files.length} files, ${graph.edgeCount} edges.`,
      );
      out.note('');
      out.note(`→ Restart the runtime:  memnox serve --code-graph ${options.out}`);
    });
}

/** Null when there is no graph, or the file is not one Graphify wrote. */
async function readGraphify(
  root: string,
): Promise<ReturnType<typeof graphifyToSnapshot> | null> {
  let raw: string;
  try {
    raw = await readFile(join(root, GRAPHIFY_OUTPUT), 'utf8');
  } catch {
    return null; // No graph built yet — the normal first-run case.
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // A half-written graph must not become a half-read one.
  }
  return isGraphifyDocument(parsed) ? graphifyToSnapshot(parsed) : null;
}

async function writeSnapshot(path: string, snapshot: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(snapshot), 'utf8');
}
