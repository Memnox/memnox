const DATA_FIELD = 'data:';

/**
 * A Streamable HTTP server may answer one POST with an SSE body rather than a
 * JSON object. Only the `data:` payloads carry JSON-RPC, so the event names and
 * ids are dropped — the proxy correlates on the JSON-RPC id, not the SSE one.
 */
export function readEventStream(body: string): string[] {
  const payloads: string[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(DATA_FIELD)) continue;
    const payload = trimmed.slice(DATA_FIELD.length).trim();
    if (payload.length > 0) payloads.push(payload);
  }
  return payloads;
}

/** True when a response body should be read as SSE rather than parsed as JSON. */
export function isEventStream(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  return contentType.toLowerCase().includes('text/event-stream');
}
