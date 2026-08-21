import { describe, expect, it, vi } from 'vitest';
import { DECISION_ENFORCEMENT } from '../src/decision-record';
import type { DecisionRecord } from '../src/decision-record';
import { DecisionSemanticSearch } from '../src/semantic-search';
import type { EmbedFn } from '../src/incremental-index';
import { InMemoryVectorIndex } from '../src/vector-index';

function decision(id: string, title: string, statement: string): DecisionRecord {
  return {
    id,
    title,
    statement,
    owner: 'backend',
    actions: ['database.migrate'],
    decidedAt: '2026-07-01T00:00:00.000Z',
    enforcement: DECISION_ENFORCEMENT.WARN,
  };
}

const DECISIONS = [
  decision('d1', 'Keep PostgreSQL', 'Transactional services stay on PostgreSQL'),
  decision('d2', 'Use Redis for caching', 'Hot reads are cached in Redis'),
  decision('d3', 'Adopt OpenTelemetry', 'All services emit OTel traces'),
];

/** Deterministic stand-in: each decision gets its own axis, so similarity is exact. */
const AXES: Record<string, number[]> = {
  d1: [1, 0, 0],
  d2: [0, 1, 0],
  d3: [0, 0, 1],
};

/** Queries are matched exactly first, so a shared word does not decide the result. */
const fakeEmbed =
  (queries: Record<string, number[]>): EmbedFn =>
  async (texts) =>
    texts.map((text) => {
      if (text in queries) return queries[text] ?? [];
      if (text.startsWith('Keep PostgreSQL')) return AXES['d1'] ?? [];
      if (text.startsWith('Use Redis')) return AXES['d2'] ?? [];
      if (text.startsWith('Adopt OpenTelemetry')) return AXES['d3'] ?? [];
      return [];
    });

describe('DecisionSemanticSearch', () => {
  const build = (embed: EmbedFn) =>
    new DecisionSemanticSearch({ index: new InMemoryVectorIndex(), embed });

  it('embeds each decision once', async () => {
    const embed = vi.fn(fakeEmbed({}));
    const search = build(embed);

    expect(await search.index(DECISIONS)).toBe(3);
    expect(await search.index(DECISIONS)).toBe(0);
    expect(embed).toHaveBeenCalledOnce();
  });

  it('finds a decision by meaning when the words do not match', async () => {
    const search = build(fakeEmbed({ 'in-memory cache layer': AXES['d2'] ?? [] }));
    await search.index(DECISIONS);

    // "in-memory cache" shares no keyword with the Redis decision.
    const hits = await search.search(DECISIONS, 'in-memory cache layer', 5);
    expect(hits[0]?.decision.id).toBe('d2');
  });

  it('still returns keyword hits when embeddings are unavailable', async () => {
    const failing: EmbedFn = async () => {
      throw new Error('embedding provider down');
    };
    const warn = vi.fn();
    const search = new DecisionSemanticSearch({
      index: new InMemoryVectorIndex(),
      embed: failing,
      logger: { warn },
    });

    const hits = await search.search(DECISIONS, 'PostgreSQL', 5);
    expect(hits[0]?.decision.id).toBe('d1');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('merges keyword and semantic results rather than replacing them', async () => {
    // Keyword finds PostgreSQL; the query's meaning points at the Redis decision.
    const search = build(fakeEmbed({ 'PostgreSQL cache': AXES['d2'] ?? [] }));
    await search.index(DECISIONS);

    const hits = await search.search(DECISIONS, 'PostgreSQL cache', 5);
    const ids = hits.map((hit) => hit.decision.id);
    expect(ids).toContain('d1');
    expect(ids).toContain('d2');
  });

  it('returns nothing for a query that matches neither path', async () => {
    const search = build(async () => []);
    expect(await search.search(DECISIONS, '', 5)).toEqual([]);
  });
});
