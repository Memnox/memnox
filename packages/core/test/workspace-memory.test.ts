import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  describeFact,
  factsAbout,
  newestFacts,
  markWorkspaceMemorySynced,
  parseWorkspaceMemory,
  readWorkspaceMemory,
  readWorkspaceMemoryCached,
  workspaceMemoryPathFor,
  writeWorkspaceMemory,
  type WorkspaceFact,
  type WorkspaceMemory,
} from '../src';

const SYNCED = '2026-09-26T08:00:00.000Z';

function fact(over: Partial<WorkspaceFact> & { id: string }): WorkspaceFact {
  return {
    kind: 'decision',
    statement: 'Retry logic must remain inside PaymentService.',
    subject: 'payments',
    ...over,
  };
}

function memory(facts: WorkspaceFact[]): WorkspaceMemory {
  return { hash: 'm1', facts, withheld: 0, syncedAt: SYNCED };
}

const RETRY = fact({
  id: 'f_retry',
  verifiedBy: 'ada@acme.test',
  settledAt: '2026-05-02T10:00:00.000Z',
});
const DECLINED = fact({
  id: 'f_declined',
  statement: 'Declined payments are never retried.',
  subject: 'payment retries',
});
const REDIS = fact({
  id: 'f_redis',
  statement: 'We do not use Redis for the billing service.',
  subject: 'billing',
});
const OWNER = fact({
  id: 'f_owner',
  kind: 'responsibility',
  statement: 'The payments team owns src/payments.',
  subject: 'payments code',
  scope: 'src/payments',
  principal: 'payments-team',
});

describe('what a prompt is about', () => {
  it('finds a decision by what it is about', () => {
    const found = factsAbout(memory([RETRY, REDIS]), {
      words: ['fix the payment retry logic'],
    });

    expect(found.map((each) => each.fact.id)).toEqual(['f_retry']);
    expect(found[0]?.matched).toContain('payment');
  });

  it('folds plurals, so "retries" meets "retry"', () => {
    const found = factsAbout(memory([DECLINED]), {
      words: ['why do retries fire twice'],
    });

    expect(found.map((each) => each.fact.id)).toEqual(['f_declined']);
  });

  it('never matches on one shared word of wording alone', () => {
    /* "service" is in the Redis statement and says nothing about billing. */
    const found = factsAbout(memory([REDIS]), { words: ['restart the service'] });

    expect(found).toEqual([]);
  });

  it('matches on two words of wording when the subject says nothing', () => {
    const found = factsAbout(memory([REDIS]), {
      words: ['can I add redis to the service'],
    });

    expect(found.map((each) => each.fact.id)).toEqual(['f_redis']);
    expect(found[0]?.onSubject).toBe(false);
  });

  it('ignores words that name nothing', () => {
    expect(
      factsAbout(memory([RETRY, REDIS]), { words: ['please fix this for me'] }),
    ).toEqual([]);
  });
});

describe('what a path is about', () => {
  it('reads a path by the parts that name something', () => {
    const found = factsAbout(memory([RETRY, REDIS]), {
      paths: ['src/payments/retry.ts'],
    });

    expect(found.map((each) => each.fact.id)).toEqual(['f_retry']);
  });

  it('holds a scope written as a path to its own segments', () => {
    const inside = factsAbout(memory([OWNER]), { paths: ['src/payments/invoice.ts'] });
    const sibling = factsAbout(memory([{ ...OWNER, subject: 'ownership' }]), {
      paths: ['src/payments-legacy/invoice.ts'],
    });

    expect(inside.map((each) => each.fact.id)).toEqual(['f_owner']);
    expect(sibling).toEqual([]);
  });

  it('puts what matched on its subject ahead of what matched on wording', () => {
    const found = factsAbout(memory([REDIS, RETRY]), {
      words: ['payment billing redis service'],
    });

    expect(found[0]?.onSubject).toBe(true);
  });
});

describe('saying it', () => {
  it('names who confirmed it, when, and where it came from', () => {
    const sentence = describeFact({
      fact: { ...RETRY, sourceRef: 'https://slack.test/p1' },
      matched: ['payment'],
      onSubject: true,
    });

    expect(sentence).toBe(
      'Your workspace settled this about payments: "Retry logic must remain inside PaymentService." (a decision, confirmed by ada@acme.test, on 2026-05-02, source https://slack.test/p1).',
    );
  });

  it('says where a fact nobody confirmed by hand came from', () => {
    const sentence = describeFact({
      fact: { ...OWNER, provenance: 'authoritative' },
      matched: [],
      onSubject: true,
    });

    expect(sentence).toContain('an ownership, from a system of record');
  });

  it('lists the newest first when nothing in particular was asked', () => {
    const facts = [
      fact({ id: 'old', settledAt: '2025-01-01T00:00:00.000Z' }),
      fact({ id: 'new', settledAt: '2026-01-01T00:00:00.000Z' }),
    ];

    expect(newestFacts(memory(facts), 1).map((each) => each.id)).toEqual(['new']);
  });
});

describe('what arrives from the control plane', () => {
  it('keeps what it can read and drops a fact with no statement', () => {
    const parsed = parseWorkspaceMemory(
      {
        hash: 'm2',
        withheld: 3,
        facts: [RETRY, { id: 'broken', kind: 'decision', subject: 'x' }, 'not a fact'],
      },
      SYNCED,
    );

    expect(parsed?.facts.map((each) => each.id)).toEqual(['f_retry']);
    expect(parsed?.withheld).toBe(3);
  });

  it('refuses a body that is not a memory at all', () => {
    expect(parseWorkspaceMemory({ facts: [] }, SYNCED)).toBeNull();
    expect(parseWorkspaceMemory('nope', SYNCED)).toBeNull();
  });

  it('round trips through the file a hook reads', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-workspace-memory-'));

    expect(await readWorkspaceMemory(home)).toBeNull();
    await writeWorkspaceMemory(home, memory([RETRY]));
    expect(await readWorkspaceMemory(home)).toEqual(memory([RETRY]));
  });

  it('is written compactly, since it can run to megabytes nobody reads by hand', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-workspace-memory-'));
    await writeWorkspaceMemory(home, memory([RETRY]));

    const text = await readFile(workspaceMemoryPathFor(home), 'utf8');
    expect(text).not.toContain('\n');
  });

  it('moves the sync time without rewriting the set', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-workspace-memory-'));
    await writeWorkspaceMemory(home, memory([RETRY]));
    const before = await readFile(workspaceMemoryPathFor(home), 'utf8');

    await markWorkspaceMemorySynced(home, '2026-09-26T09:00:00.000Z');

    expect(await readFile(workspaceMemoryPathFor(home), 'utf8')).toBe(before);
    expect((await readWorkspaceMemory(home))?.syncedAt).toBe('2026-09-26T09:00:00.000Z');
  });

  it('parses again for a long lived reader only when the file changed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-workspace-memory-'));
    await writeWorkspaceMemory(home, memory([RETRY]));

    const first = await readWorkspaceMemoryCached(home);
    expect(await readWorkspaceMemoryCached(home)).toBe(first);

    await markWorkspaceMemorySynced(home, '2026-09-26T09:00:00.000Z');
    expect((await readWorkspaceMemoryCached(home))?.syncedAt).toBe(
      '2026-09-26T09:00:00.000Z',
    );

    await writeFile(
      workspaceMemoryPathFor(home),
      JSON.stringify({
        ...memory([RETRY, DECLINED]),
        syncedAt: '2026-09-26T10:00:00.000Z',
      }),
    );
    expect((await readWorkspaceMemoryCached(home))?.facts).toHaveLength(2);
  });
});
