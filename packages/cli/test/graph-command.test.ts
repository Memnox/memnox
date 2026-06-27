import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from './cli-harness';

let repo: string;
let snapshot: string;

/** A three-file chain: handler imports service, service imports the payment module. */
async function writeRepo(): Promise<void> {
  await mkdir(join(repo, 'src', 'payment'), { recursive: true });
  await writeFile(
    join(repo, 'src', 'payment', 'charge.ts'),
    'export const charge = (): void => {};\n',
    'utf8',
  );
  await writeFile(
    join(repo, 'src', 'billing.ts'),
    "import { charge } from './payment/charge';\nexport const bill = charge;\n",
    'utf8',
  );
  await writeFile(
    join(repo, 'src', 'handler.ts'),
    "import { bill } from './billing';\nexport const handle = bill;\n",
    'utf8',
  );
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'memnox-graph-'));
  snapshot = join(repo, '.memnox', 'code-graph.json');
  await writeRepo();
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('memnox graph build', () => {
  it('writes a snapshot and reports what it graphed', async () => {
    const { out } = await runCli(['graph', 'build', repo, '--out', snapshot]);

    expect(out.text).toContain('Graphed 3 files, 2 import edges');
    const written = JSON.parse(await readFile(snapshot, 'utf8')) as {
      files: unknown[];
    };
    expect(written.files).toHaveLength(3);
  });

  it('fails when the directory holds no source the graph can parse', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'memnox-empty-'));
    try {
      await expect(runCli(['graph', 'build', empty, '--out', snapshot])).rejects.toThrow(
        /no source files found/,
      );
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe('memnox graph explain', () => {
  it('separates direct importers from transitive reach', async () => {
    await runCli(['graph', 'build', repo, '--out', snapshot]);

    const { out } = await runCli([
      'graph',
      'explain',
      'src/payment/charge.ts',
      '--graph',
      snapshot,
    ]);

    expect(out.text).toContain('File     : src/payment/charge.ts');
    expect(out.text).toContain('direct    src/billing.ts');
    expect(out.text).toContain('indirect  src/handler.ts');
  });

  it('reports a leaf as reaching nothing', async () => {
    await runCli(['graph', 'build', repo, '--out', snapshot]);

    const { out } = await runCli([
      'graph',
      'explain',
      'src/handler.ts',
      '--graph',
      snapshot,
    ]);

    expect(out.text).toContain('Nothing imports this file');
  });

  it('reports no match for a file outside the graph', async () => {
    await runCli(['graph', 'build', repo, '--out', snapshot]);

    const { out } = await runCli([
      'graph',
      'explain',
      'src/does-not-exist.ts',
      '--graph',
      snapshot,
    ]);

    expect(out.text).toContain('No unique match');
  });
});
