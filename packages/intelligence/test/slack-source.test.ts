import { describe, expect, it, vi } from 'vitest';
import { SlackSource, SlackSourceError } from '../src/providers/slack-source';

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200 });

const history = (messages: unknown[]): Response => ok({ ok: true, messages });

const source = (
  impl: typeof globalThis.fetch,
  over: {
    sleep?: (ms: number) => Promise<void>;
    onTruncated?: (pages: number) => void;
  } = {},
): SlackSource =>
  new SlackSource({
    token: 'xoxb-test',
    fetch: impl,
    sleep: over.sleep ?? (async () => {}),
    ...(over.onTruncated === undefined ? {} : { onTruncated: over.onTruncated }),
  });

const page = (messages: unknown[], nextCursor?: string): Response =>
  ok({
    ok: true,
    messages,
    ...(nextCursor === undefined
      ? {}
      : { has_more: true, response_metadata: { next_cursor: nextCursor } }),
  });

const throttled = (retryAfter?: string): Response =>
  new Response('{}', {
    status: 429,
    ...(retryAfter === undefined ? {} : { headers: { 'retry-after': retryAfter } }),
  });

describe('SlackSource', () => {
  it('sends the bot token and asks for one channel', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(String(url));
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers['authorization']).toBe('Bearer xoxb-test');
      return history([]);
    }) as unknown as typeof globalThis.fetch;

    await source(fetchImpl).read('C0123');

    expect(calls[0]).toContain('conversations.history');
    expect(calls[0]).toContain('channel=C0123');
  });

  it('returns messages oldest first, with a permalink on each', async () => {
    const fetchImpl = (async () =>
      history([
        { ts: '1700000200.000200', user: 'bob', text: 'second' },
        { ts: '1700000100.000100', user: 'alice', text: 'first' },
      ])) as unknown as typeof globalThis.fetch;

    const messages = await source(fetchImpl).read('C0123');

    expect(messages.map((message) => message.text)).toEqual(['first', 'second']);
    expect(messages[0]?.sourceRef).toBe(
      'https://slack.com/archives/C0123/p1700000100000100',
    );
    expect(messages[0]?.occurredAt).toBe(new Date(1700000100 * 1000).toISOString());
  });

  it('drops bot posts and join notices before a model ever sees them', async () => {
    const fetchImpl = (async () =>
      history([
        { ts: '1.0', user: 'alice', text: 'a real decision' },
        { ts: '2.0', bot_id: 'B1', text: 'deploy finished' },
        { ts: '3.0', user: 'bob', text: 'joined', subtype: 'channel_join' },
        { ts: '4.0', user: 'carol' },
      ])) as unknown as typeof globalThis.fetch;

    const messages = await source(fetchImpl).read('C0123');

    expect(messages.map((message) => message.text)).toEqual(['a real decision']);
  });

  it('passes a since bound through as Slack expects it', async () => {
    let seen = '';
    const fetchImpl = (async (url: string | URL | Request) => {
      seen = String(url);
      return history([]);
    }) as unknown as typeof globalThis.fetch;

    await source(fetchImpl).read('C0123', '2026-05-01T00:00:00.000Z');

    expect(seen).toContain(`oldest=${Date.parse('2026-05-01T00:00:00.000Z') / 1000}`);
  });

  it('raises rather than returning an empty channel when Slack refuses', async () => {
    const refused = (async () =>
      ok({ ok: false, error: 'not_in_channel' })) as unknown as typeof globalThis.fetch;

    await expect(source(refused).read('C0123')).rejects.toBeInstanceOf(SlackSourceError);
  });

  it('raises on a transport failure', async () => {
    const failing = (async () =>
      new Response('nope', { status: 500 })) as unknown as typeof globalThis.fetch;

    await expect(source(failing).read('C0123')).rejects.toBeInstanceOf(SlackSourceError);
  });
});

describe('SlackSource pagination', () => {
  it('follows the cursor and returns the whole run oldest first', async () => {
    const pages = [
      page([{ ts: '3.0', user: 'carol', text: 'third' }], 'cursor-1'),
      page([
        { ts: '2.0', user: 'bob', text: 'second' },
        { ts: '1.0', user: 'alice', text: 'first' },
      ]),
    ];
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return pages.shift() as Response;
    }) as unknown as typeof globalThis.fetch;

    const messages = await source(fetchImpl).read('C0123');

    expect(messages.map((message) => message.text)).toEqual(['first', 'second', 'third']);
    expect(seen[1]).toContain('cursor=cursor-1');
  });

  it('stops at the end of the channel rather than looping on an empty cursor', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return ok({ ok: true, messages: [], has_more: true, response_metadata: {} });
    }) as unknown as typeof globalThis.fetch;

    await source(fetchImpl).read('C0123');

    expect(calls).toBe(1);
  });

  it('reports a run that stopped at its page bound rather than stopping silently', async () => {
    let truncatedAt: number | undefined;
    const fetchImpl = (async () =>
      page(
        [{ ts: '1.0', user: 'alice', text: 'more' }],
        'always-more',
      )) as unknown as typeof globalThis.fetch;

    await source(fetchImpl, { onTruncated: (pages) => (truncatedAt = pages) }).read(
      'C0123',
    );

    expect(truncatedAt).toBe(20);
  });
});

describe('SlackSource throttling', () => {
  it('waits the time Slack asked for, then retries the same page', async () => {
    const waits: number[] = [];
    const responses = [throttled('2'), page([{ ts: '1.0', user: 'alice', text: 'ok' }])];
    const fetchImpl = (async () =>
      responses.shift() as Response) as unknown as typeof globalThis.fetch;

    const messages = await source(fetchImpl, {
      sleep: async (ms) => {
        waits.push(ms);
      },
    }).read('C0123');

    expect(waits).toEqual([2_000]);
    expect(messages).toHaveLength(1);
  });

  it('caps an absurd retry-after rather than hanging the run', async () => {
    const waits: number[] = [];
    const responses = [throttled('99999'), page([])];
    const fetchImpl = (async () =>
      responses.shift() as Response) as unknown as typeof globalThis.fetch;

    await source(fetchImpl, {
      sleep: async (ms) => {
        waits.push(ms);
      },
    }).read('C0123');

    expect(waits).toEqual([30_000]);
  });

  it('gives up rather than looping when the token stays throttled', async () => {
    const fetchImpl = (async () => throttled('1')) as unknown as typeof globalThis.fetch;

    await expect(source(fetchImpl).read('C0123')).rejects.toThrow(/rate limiting/);
  });
});
