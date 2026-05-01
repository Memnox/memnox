import { describe, expect, it } from 'vitest';
import { CodeGraph, type GraphSource } from '../src/code-graph';
import { computeBlastRadius } from '../src/blast-radius';
import { MAX_BLAST_RADIUS_DEPTH } from '../src/code-graph.constants';

/**
 * money.ts is imported by checkout.ts, which is imported by the API layer.
 * unrelated.ts touches none of it.
 */
const SOURCES: GraphSource[] = [
  { path: 'src/utils/money.ts', content: 'export const round = (n: number) => n;' },
  {
    path: 'src/payment/checkout.ts',
    content: "import { round } from '../utils/money';",
  },
  {
    path: 'src/api/payment.routes.ts',
    content: "import { checkout } from '../payment/checkout';",
  },
  { path: 'src/unrelated.ts', content: 'export const noop = () => {};' },
];

const graph = CodeGraph.build(SOURCES);

describe('CodeGraph.build', () => {
  it('records forward and reverse edges for internal imports', () => {
    expect(graph.importsOf('src/payment/checkout.ts')).toEqual(['src/utils/money.ts']);
    expect(graph.importersOf('src/utils/money.ts')).toEqual(['src/payment/checkout.ts']);
  });

  it('ignores external packages', () => {
    const withPackage = CodeGraph.build([
      { path: 'src/a.ts', content: "import express from 'express';" },
    ]);
    expect(withPackage.importsOf('src/a.ts')).toEqual([]);
    expect(withPackage.edgeCount).toBe(0);
  });

  it('survives a self-import without creating a self-edge', () => {
    const selfImport = CodeGraph.build([{ path: 'src/a.ts', content: "import './a';" }]);
    expect(selfImport.importsOf('src/a.ts')).toEqual([]);
  });
});

describe('computeBlastRadius', () => {
  it('walks transitively, not just one hop', () => {
    const radius = computeBlastRadius(graph, 'src/utils/money.ts');
    expect(radius.resolvedPath).toBe('src/utils/money.ts');
    expect(radius.directImporters).toEqual(['src/payment/checkout.ts']);
    expect(radius.reached).toEqual([
      'src/payment/checkout.ts',
      'src/api/payment.routes.ts',
    ]);
    expect(radius.depth).toBe(2);
    expect(radius.truncated).toBe(false);
  });

  it('reports an empty radius for a leaf nothing imports', () => {
    const radius = computeBlastRadius(graph, 'src/api/payment.routes.ts');
    expect(radius.reached).toEqual([]);
    expect(radius.depth).toBe(0);
  });

  it('resolves a unique suffix so hook-supplied paths still match', () => {
    expect(computeBlastRadius(graph, 'utils/money.ts').resolvedPath).toBe(
      'src/utils/money.ts',
    );
  });

  it('stays silent when a suffix is ambiguous rather than picking one', () => {
    const ambiguous = CodeGraph.build([
      { path: 'a/config.ts', content: '' },
      { path: 'b/config.ts', content: '' },
    ]);
    const radius = computeBlastRadius(ambiguous, 'config.ts');
    expect(radius.resolvedPath).toBeNull();
    expect(radius.reached).toEqual([]);
  });

  it('terminates on a cycle instead of looping forever', () => {
    const cyclic = CodeGraph.build([
      { path: 'src/a.ts', content: "import './b';" },
      { path: 'src/b.ts', content: "import './a';" },
    ]);
    const radius = computeBlastRadius(cyclic, 'src/a.ts');
    expect(radius.reached).toEqual(['src/b.ts']);
  });

  it('marks a chain deeper than the ceiling as truncated', () => {
    const depth = MAX_BLAST_RADIUS_DEPTH + 5;
    const chain: GraphSource[] = Array.from({ length: depth }, (_, index) => ({
      path: `src/f${index}.ts`,
      content: index === 0 ? '' : `import './f${index - 1}';`,
    }));
    const radius = computeBlastRadius(CodeGraph.build(chain), 'src/f0.ts');
    expect(radius.truncated).toBe(true);
    expect(radius.depth).toBe(MAX_BLAST_RADIUS_DEPTH);
  });
});

describe('snapshots', () => {
  it('round-trips to the same reachability', () => {
    const restored = CodeGraph.fromSnapshot(graph.toSnapshot());
    expect(restored.files).toEqual(graph.files);
    expect(restored.edgeCount).toBe(graph.edgeCount);
    expect(computeBlastRadius(restored, 'src/utils/money.ts').reached).toEqual([
      'src/payment/checkout.ts',
      'src/api/payment.routes.ts',
    ]);
  });

  it('rejects a snapshot written by a different format version', () => {
    const snapshot = { ...graph.toSnapshot(), version: 99 };
    expect(() => CodeGraph.fromSnapshot(snapshot)).toThrow(
      /unsupported code graph snapshot/,
    );
  });

  it('only stamps builtAt when the writer supplies one', () => {
    expect(graph.toSnapshot().builtAt).toBeUndefined();
    expect(graph.toSnapshot('2026-01-01T00:00:00.000Z').builtAt).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });
});
