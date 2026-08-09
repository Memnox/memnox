import type { SourceMessage } from '../organization-extractor';

const SLACK_API = 'https://slack.com/api';
const HISTORY_LIMIT = 200;
const ARCHIVE_BASE = 'https://slack.com/archives';
/**
 * Pages one run will walk before it stops and says so.
 *
 * A bound rather than "read the whole channel", because a busy channel has
 * years in it and one run is not the place to discover that. Reaching it is
 * reported, never silent — a backfill that quietly stopped halfway looks
 * exactly like a channel with nothing older in it.
 */
const MAX_PAGES = 20;
/** Slack asks for a wait on 429; this caps how long we will honour before giving up. */
const MAX_RETRY_WAIT_MS = 30_000;
const DEFAULT_RETRY_WAIT_MS = 1_000;
const RATE_LIMITED = 429;

/**
 * Where an extraction run gets its messages.
 *
 * A port rather than a Slack call inline, for the usual reason and one more:
 * every connector after this one — Teams, Drive, a meeting transcript — is the
 * same shape, and the extractor must not learn the difference.
 */
export interface MessageSource {
  readonly name: string;
  /** Messages in a channel, oldest first, since an ISO timestamp. */
  read(channel: string, since?: string): Promise<SourceMessage[]>;
}

export interface SlackSourceOptions {
  /** A bot token with `channels:history` and `users:read`. */
  token: string;
  /** Injected so tests exercise real client code against a fake transport. */
  fetch?: typeof globalThis.fetch;
  /** Injected so a throttled run is testable without actually waiting. */
  sleep?: (ms: number) => Promise<void>;
  /** Told when a run stops at its page bound, so a partial read is never silent. */
  onTruncated?: (pages: number) => void;
}

export class SlackSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlackSourceError';
  }
}

/** Reads channel history. Read-only by construction: nothing here posts. */
export class SlackSource implements MessageSource {
  readonly name = 'slack';
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: SlackSourceOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Every message since the bound, oldest first, following Slack's cursor.
   *
   * One page was enough to demonstrate the connector and wrong for the job it
   * exists to do: the decision somebody is looking for is usually the one far
   * enough back that nobody remembers it, which is past the first two hundred
   * messages by definition.
   */
  async read(channel: string, since?: string): Promise<SourceMessage[]> {
    const collected: SourceMessage[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await this.page(channel, since, cursor);
      collected.push(
        ...(body.messages ?? [])
          .filter(isReadable)
          .map((message) => toSourceMessage(message, channel)),
      );

      cursor = nextCursor(body);
      if (cursor === undefined) {
        // Slack pages newest first; the caller reads a conversation forwards.
        return collected.reverse();
      }
    }

    if (this.options.onTruncated !== undefined) this.options.onTruncated(MAX_PAGES);
    return collected.reverse();
  }

  /** One page, retried once when Slack asks us to wait. */
  private async page(
    channel: string,
    since: string | undefined,
    cursor: string | undefined,
  ): Promise<SlackHistory> {
    const response = await this.request(channel, since, cursor);
    if (response.status !== RATE_LIMITED) return this.readBody(response);

    await this.sleep(retryWaitMs(response));
    const retried = await this.request(channel, since, cursor);
    if (retried.status === RATE_LIMITED) {
      /* Twice in a row is a workspace being throttled rather than a burst of
         ours, and looping on it turns one slow import into an outage for every
         other integration sharing the token. */
      throw new SlackSourceError('slack is rate limiting this token — try again later');
    }
    return this.readBody(retried);
  }

  private request(
    channel: string,
    since: string | undefined,
    cursor: string | undefined,
  ): Promise<Response> {
    const params = new URLSearchParams({ channel, limit: String(HISTORY_LIMIT) });
    if (since !== undefined) params.set('oldest', String(Date.parse(since) / 1000));
    if (cursor !== undefined) params.set('cursor', cursor);

    return this.fetchImpl(`${SLACK_API}/conversations.history?${params.toString()}`, {
      headers: { authorization: `Bearer ${this.options.token}` },
    });
  }

  private async readBody(response: Response): Promise<SlackHistory> {
    if (!response.ok) {
      throw new SlackSourceError(`slack answered ${response.status}`);
    }
    const body = (await response.json()) as SlackHistory;
    if (body.ok !== true) {
      throw new SlackSourceError(`slack refused: ${body.error ?? 'unknown error'}`);
    }
    return body;
  }
}

/** Named rather than chained: an absent cursor is the normal end of a channel. */
function nextCursor(body: SlackHistory): string | undefined {
  if (body.has_more !== true) return undefined;
  const metadata = body.response_metadata;
  if (metadata === undefined) return undefined;
  const cursor = metadata.next_cursor;
  return cursor === undefined || cursor.length === 0 ? undefined : cursor;
}

/** Slack's own number when it gives one, bounded so a bad header cannot hang a run. */
function retryWaitMs(response: Response): number {
  const header = response.headers.get('retry-after');
  if (header === null) return DEFAULT_RETRY_WAIT_MS;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_RETRY_WAIT_MS;
  return Math.min(seconds * 1_000, MAX_RETRY_WAIT_MS);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface SlackHistory {
  ok?: boolean;
  error?: string;
  messages?: SlackMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

interface SlackMessage {
  ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  subtype?: string;
}

/**
 * A message a person actually wrote.
 *
 * Bots and join/leave notices are dropped before the model sees them: a channel
 * where a deploy bot posts every hour would otherwise fill an extraction run
 * with the same non-statement, and a reviewer would stop reading the queue.
 */
function isReadable(
  message: SlackMessage,
): message is SlackMessage & { ts: string; text: string } {
  if (typeof message.ts !== 'string' || typeof message.text !== 'string') return false;
  if (message.text.length === 0) return false;
  if (message.bot_id !== undefined) return false;
  return message.subtype === undefined;
}

function toSourceMessage(
  message: SlackMessage & { ts: string; text: string },
  channel: string,
): SourceMessage {
  return {
    id: message.ts,
    author: message.user ?? 'unknown',
    occurredAt: new Date(Number(message.ts) * 1000).toISOString(),
    text: message.text,
    sourceRef: `${ARCHIVE_BASE}/${channel}/p${message.ts.replace('.', '')}`,
  };
}
