export interface VectorEntry {
  id: string;
  vector: number[];
}

export interface VectorMatch {
  id: string;
  similarity: number;
}

export interface VectorIndex {
  upsert(entries: readonly VectorEntry[]): Promise<void>;
  query(vector: readonly number[], limit: number): Promise<VectorMatch[]>;
  remove(ids: readonly string[]): Promise<void>;
  /** Ids already embedded, so callers only pay to embed what changed. */
  indexed(): Promise<string[]>;
}

/** Vectors of different lengths never match — a mismatch means a model changed. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    dot += left * right;
    magnitudeA += left * left;
    magnitudeB += right * right;
  }
  if (magnitudeA === 0 || magnitudeB === 0) return 0;
  return dot / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
}

export class InMemoryVectorIndex implements VectorIndex {
  private readonly vectors = new Map<string, number[]>();

  async upsert(entries: readonly VectorEntry[]): Promise<void> {
    for (const entry of entries) this.vectors.set(entry.id, [...entry.vector]);
  }

  async query(vector: readonly number[], limit: number): Promise<VectorMatch[]> {
    return [...this.vectors.entries()]
      .map(([id, stored]) => ({ id, similarity: cosineSimilarity(vector, stored) }))
      .filter((match) => match.similarity > 0)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  async remove(ids: readonly string[]): Promise<void> {
    for (const id of ids) this.vectors.delete(id);
  }

  async indexed(): Promise<string[]> {
    return [...this.vectors.keys()];
  }
}
