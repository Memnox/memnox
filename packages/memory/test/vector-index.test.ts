import { describe, expect, it } from 'vitest';
import { cosineSimilarity, InMemoryVectorIndex } from '../src/vector-index';

describe('cosineSimilarity', () => {
  it('is 1 for identical direction and 0 for orthogonal', () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it('returns 0 for mismatched lengths or empty vectors', () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('InMemoryVectorIndex', () => {
  it('returns nearest first and honours the limit', async () => {
    const index = new InMemoryVectorIndex();
    await index.upsert([
      { id: 'a', vector: [1, 0] },
      { id: 'b', vector: [0.9, 0.1] },
      { id: 'c', vector: [0, 1] },
    ]);

    const matches = await index.query([1, 0], 2);
    expect(matches.map((match) => match.id)).toEqual(['a', 'b']);
  });

  it('upserts in place and removes', async () => {
    const index = new InMemoryVectorIndex();
    await index.upsert([{ id: 'a', vector: [1, 0] }]);
    await index.upsert([{ id: 'a', vector: [0, 1] }]);
    expect(await index.indexed()).toEqual(['a']);
    expect((await index.query([0, 1], 5))[0]?.similarity).toBeCloseTo(1);

    await index.remove(['a']);
    expect(await index.indexed()).toEqual([]);
  });
});
