const DATA_FIELD = 'data:';

/** Only `data:` payloads carry JSON-RPC; event names and ids are framing. */
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
