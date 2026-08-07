import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { registerGraphifyCommand } from '../src/commands/graphify.command';
import { GRAPHIFY_OUTPUT, type CommandRunner } from '../src/graphify-runner';
import { plainStyle } from '../src/style';

/** Records what was run, and answers from a table — no subprocess, no network. */
class FakeRunner implements CommandRunner {
  readonly calls: string[] = [];
  constructor(private readonly answers: Record<string, string | null>) {}

  run(command: string, args: readonly string[]): string | null {
    const key = [command, ...args].join(' ');
    this.calls.push(key);
    if (key in this.answers) return this.answers[key] ?? null;
    return command in this.answers ? (this.answers[command] ?? null) : null;
  }
}

const GRAPH = {
  nodes: [
    { id: 'a', source_file: 'src/a.ts' },
    { id: 'b', source_file: 'src/b.ts' },
  ],
  links: [{ source: 'a', target: 'b', relation: 'calls', confidence: 'EXTRACTED' }],
};

describe('memnox graphify', () => {
  let root: string;
  let out: RecordedOutput;

  const run = async (args: string[], runner: CommandRunner): Promise<void> => {
    const program = new Command();
    program.exitOverride();
    registerGraphifyCommand(
      program,
      new CliContext(out, undefined, plainStyle, async () => ({}), {}),
      runner,
      () => root,
    );
    await program.parseAsync(['node', 'memnox', 'graphify', ...args]);
  };

  const writeGraph = async (document: unknown): Promise<void> => {
    await mkdir(join(root, 'graphify-out'), { recursive: true });
    await writeFile(join(root, GRAPHIFY_OUTPUT), JSON.stringify(document), 'utf8');
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'memnox-graphify-'));
    out = new RecordedOutput();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('status', () => {
    it('says what is missing and how to get it', async () => {
      await run(['status'], new FakeRunner({}));

      expect(out.text).toContain('not installed');
      expect(out.notes.join('\n')).toContain('graphifyy');
    });

    it('reports the graph when one exists', async () => {
      await writeGraph(GRAPH);

      await run(['status'], new FakeRunner({ graphify: 'graphify 0.8.36' }));

      expect(out.text).toContain('graphify 0.8.36');
      expect(out.text).toContain('2 files, 1 edges');
    });
  });

  describe('install', () => {
    it('does nothing when it is already there', async () => {
      const runner = new FakeRunner({ graphify: 'graphify 0.8.36' });

      await run(['install'], runner);

      expect(out.text).toContain('already installed');
      expect(runner.calls).not.toContain('uv tool install graphifyy');
    });

    it('prefers an isolated installer over a bare pip', async () => {
      const runner = new FakeRunner({
        uv: 'uv 0.11.20',
        'uv tool install graphifyy': 'installed',
      });

      await run(['install'], runner);

      expect(out.text).toContain('via uv');
    });

    it('falls through to pipx when uv is absent', async () => {
      const runner = new FakeRunner({
        pipx: 'pipx 1.0',
        'pipx install graphifyy': 'installed',
      });

      await run(['install'], runner);

      expect(out.text).toContain('via pipx');
    });

    it('names the installers it tried rather than failing blankly', async () => {
      await expect(run(['install'], new FakeRunner({}))).rejects.toThrow(
        /No Python installer found/,
      );
    });
  });

  describe('build', () => {
    it('refuses before Graphify is installed, and says how', async () => {
      await expect(run(['build'], new FakeRunner({}))).rejects.toThrow(/uv tool install/);
    });

    it('uses the AST-only path — no LLM, no network', async () => {
      await writeGraph(GRAPH);
      const runner = new FakeRunner({
        graphify: 'graphify 0.8.36',
        [`graphify update ${root} --no-cluster`]: 'ok',
      });

      await run(['build'], runner);

      expect(runner.calls).toContain(`graphify update ${root} --no-cluster`);
      expect(out.text).toContain('2 files, 1 edges');
    });
  });

  describe('use', () => {
    it('writes a snapshot the runtime can load', async () => {
      await writeGraph(GRAPH);
      const outPath = join(root, 'snapshot.json');

      await run(['use', '--out', outPath], new FakeRunner({}));

      const snapshot = JSON.parse(await readFile(outPath, 'utf8')) as {
        files: string[];
        edges: number[][];
      };
      expect(snapshot.files).toEqual(['src/a.ts', 'src/b.ts']);
      expect(snapshot.edges).toEqual([[0, 1]]);
    });

    it('says how to build one when there is nothing to convert', async () => {
      await expect(run(['use'], new FakeRunner({}))).rejects.toThrow(
        /memnox graphify build/,
      );
    });

    it('treats a corrupt graph as absent rather than half-reading it', async () => {
      await mkdir(join(root, 'graphify-out'), { recursive: true });
      await writeFile(join(root, GRAPHIFY_OUTPUT), '{ not json', 'utf8');

      await expect(run(['use'], new FakeRunner({}))).rejects.toThrow(/build/);
    });
  });
});
