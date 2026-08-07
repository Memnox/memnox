import { describe, expect, it } from 'vitest';
import { CodeGraph } from '../src/code-graph';
import { computeBlastRadius } from '../src/blast-radius';
import { graphifyToSnapshot, isGraphifyDocument } from '../src/graphify-import';

/**
 * Captured verbatim from `graphify update . --no-cluster` (graphify 0.8.36) on a
 * two-file project. Pinned so an upstream schema change fails here loudly rather
 * than silently under-reporting reach — a missed edge is a missed escalation.
 */
const REAL_OUTPUT = {
  nodes: [
    {
      id: 'src_checkout',
      label: 'checkout.ts',
      file_type: 'code',
      source_file: 'src/checkout.ts',
      source_location: 'L1',
      _origin: 'ast',
    },
    {
      id: 'src_checkout_charge',
      label: 'charge()',
      file_type: 'code',
      source_file: 'src/checkout.ts',
      source_location: 'L2',
      _origin: 'ast',
    },
    {
      id: 'src_money',
      label: 'money.ts',
      file_type: 'code',
      source_file: 'src/money.ts',
      source_location: 'L1',
      _origin: 'ast',
    },
    {
      id: 'src_money_round',
      label: 'round()',
      file_type: 'code',
      source_file: 'src/money.ts',
      source_location: 'L1',
      _origin: 'ast',
    },
  ],
  links: [
    {
      source: 'src_checkout',
      target: 'src_money',
      relation: 'imports_from',
      context: 'import',
      confidence: 'EXTRACTED',
      weight: 1.0,
    },
    {
      source: 'src_checkout',
      target: 'src_money_round',
      relation: 'imports',
      context: 'import',
      confidence: 'EXTRACTED',
      weight: 1.0,
    },
    {
      source: 'src_checkout',
      target: 'src_checkout_charge',
      relation: 'contains',
      confidence: 'EXTRACTED',
      weight: 1.0,
    },
    {
      source: 'src_money',
      target: 'src_money_round',
      relation: 'contains',
      confidence: 'EXTRACTED',
      weight: 1.0,
    },
  ],
};

/**
 * Captured verbatim from `graphify extract . --out DIR --no-cluster` (0.8.36).
 * The same run that `update` names `links`, `extract` names `edges` — pinned
 * because reading one and not the other silently reports zero reach.
 */
const REAL_EXTRACT_OUTPUT = {
  nodes: REAL_OUTPUT.nodes,
  edges: REAL_OUTPUT.links,
  hyperedges: [],
  input_tokens: 0,
  output_tokens: 0,
};

describe('isGraphifyDocument', () => {
  it('accepts a real graph.json', () => {
    expect(isGraphifyDocument(REAL_OUTPUT)).toBe(true);
  });

  it('accepts the extract variant, which names the array "edges"', () => {
    expect(isGraphifyDocument(REAL_EXTRACT_OUTPUT)).toBe(true);
  });

  it('rejects anything else rather than half-reading it', () => {
    expect(isGraphifyDocument(null)).toBe(false);
    expect(isGraphifyDocument({ nodes: [] })).toBe(false);
    expect(isGraphifyDocument({ links: [] })).toBe(false);
  });
});

describe('graphifyToSnapshot', () => {
  it('collapses symbol-level edges onto the files they came from', () => {
    const { snapshot } = graphifyToSnapshot(REAL_OUTPUT);

    expect(snapshot.files).toEqual(['src/checkout.ts', 'src/money.ts']);
    // Two symbol links between the same pair of files are one file edge.
    expect(snapshot.edges).toEqual([[0, 1]]);
  });

  it('drops contains edges — within-file structure is not reachability', () => {
    const { edgeCount } = graphifyToSnapshot(REAL_OUTPUT);

    expect(edgeCount).toBe(1);
  });

  it('keeps only EXTRACTED edges, and says how many it dropped', () => {
    const withInferred = {
      ...REAL_OUTPUT,
      links: [
        ...REAL_OUTPUT.links,
        {
          source: 'src_money',
          target: 'src_checkout',
          relation: 'calls',
          confidence: 'INFERRED',
          weight: 0.5,
        },
      ],
    };

    const { snapshot, inferredSkipped } = graphifyToSnapshot(withInferred);

    // A model-derived edge must never reach the decision path.
    expect(inferredSkipped).toBe(1);
    expect(snapshot.edges).toEqual([[0, 1]]);
  });

  it('keeps a cross-file call edge — the reach the regex walker misses', () => {
    const withCall = {
      nodes: REAL_OUTPUT.nodes,
      links: [
        {
          source: 'src_checkout_charge',
          target: 'src_money_round',
          relation: 'calls',
          confidence: 'EXTRACTED',
          weight: 1.0,
        },
      ],
    };

    const { snapshot } = graphifyToSnapshot(withCall);

    expect(snapshot.edges).toEqual([[0, 1]]);
  });

  it('ignores nodes with no file, and edges pointing at them', () => {
    const withConcept = {
      nodes: [...REAL_OUTPUT.nodes, { id: 'concept_payments' }],
      links: [
        {
          source: 'src_checkout',
          target: 'concept_payments',
          relation: 'relates_to',
          confidence: 'EXTRACTED',
        },
      ],
    };

    const { snapshot } = graphifyToSnapshot(withConcept);

    expect(snapshot.files).toEqual(['src/checkout.ts', 'src/money.ts']);
    expect(snapshot.edges).toEqual([]);
  });

  it('produces a snapshot blast radius can walk', () => {
    const { snapshot } = graphifyToSnapshot(REAL_OUTPUT);

    const radius = computeBlastRadius(CodeGraph.fromSnapshot(snapshot), 'src/money.ts');

    // Changing money.ts reaches checkout.ts — which is the whole point.
    expect(radius.reached).toEqual(['src/checkout.ts']);
  });

  it('reads both writers identically — update and extract agree', () => {
    const fromUpdate = graphifyToSnapshot(REAL_OUTPUT);
    const fromExtract = graphifyToSnapshot(REAL_EXTRACT_OUTPUT);

    expect(fromExtract.snapshot).toEqual(fromUpdate.snapshot);
    expect(fromExtract.edgeCount).toBe(fromUpdate.edgeCount);
  });
});
