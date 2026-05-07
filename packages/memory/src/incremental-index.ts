import type { VectorIndex } from './vector-index';

export interface EmbeddableItem {
  id: string;
  text: string;
}

/** Injected rather than imported so this package stays free of provider code. */
export type EmbedFn = (texts: readonly string[]) => Promise<number[][]>;

/**
 * Embeds only what the index has not seen, so re-indexing a corpus costs nothing
 * for the part that has not changed. Returns how many items were newly embedded.
 */
export async function indexNewItems(
  index: VectorIndex,
  items: readonly EmbeddableItem[],
  embed: EmbedFn,
): Promise<number> {
  const known = new Set(await index.indexed());
  const pending = items.filter((item) => !known.has(item.id));
  if (pending.length === 0) return 0;

  const vectors = await embed(pending.map((item) => item.text));
  await index.upsert(
    pending.flatMap((item, position) => {
      const vector = vectors[position];
      return vector ? [{ id: item.id, vector }] : [];
    }),
  );
  return pending.length;
}
