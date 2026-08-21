import {
  CONTENT_TYPE_EVENT_STREAM,
  CONTENT_TYPE_JSON,
  HEADER_CONTENT_TYPE,
  HEADER_MCP_SESSION,
} from './gateway.constants';
import { isEventStream, readEventStream } from './event-stream';

/** An interface, so tests drive the real routing code without a socket. */
export interface UpstreamServer {
  /** Sends one JSON-RPC payload on; returns the payloads that came back. */
  send(payload: string, sessionId?: string): Promise<string[]>;
}

export interface HttpUpstreamOptions {
  url: string;
  /** Separate from the caller's Memnox token, which is never forwarded onward. */
  authorization?: string;
  fetchImpl?: typeof fetch;
}

export class HttpUpstreamServer implements UpstreamServer {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpUpstreamOptions) {
    this.fetchImpl = options.fetchImpl === undefined ? fetch : options.fetchImpl;
  }

  async send(payload: string, sessionId?: string): Promise<string[]> {
    const headers: Record<string, string> = {
      [HEADER_CONTENT_TYPE]: CONTENT_TYPE_JSON,
      accept: `${CONTENT_TYPE_JSON}, ${CONTENT_TYPE_EVENT_STREAM}`,
    };
    if (this.options.authorization !== undefined) {
      headers['authorization'] = this.options.authorization;
    }
    if (sessionId !== undefined) headers[HEADER_MCP_SESSION] = sessionId;

    const response = await this.fetchImpl(this.options.url, {
      method: 'POST',
      headers,
      body: payload,
    });

    // 202 is the spec's answer to a notification: accepted, nothing to return.
    if (response.status === 202) return [];

    const body = await response.text();
    if (body.trim().length === 0) return [];
    if (isEventStream(response.headers.get(HEADER_CONTENT_TYPE) ?? undefined)) {
      return readEventStream(body);
    }
    return [body];
  }
}
