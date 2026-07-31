import { describe, expect, it } from 'vitest';
import { isEventStream, readEventStream } from '../src/index';

describe('readEventStream', () => {
  it('keeps only the data payloads', () => {
    const body = 'event: message\nid: 3\ndata: {"a":1}\n\ndata: {"b":2}\n\n';

    expect(readEventStream(body)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('reads a data field written without a space', () => {
    expect(readEventStream('data:{"a":1}\n\n')).toEqual(['{"a":1}']);
  });

  it('tolerates CRLF line endings', () => {
    expect(readEventStream('event: message\r\ndata: {"a":1}\r\n\r\n')).toEqual([
      '{"a":1}',
    ]);
  });

  it('drops a data field with nothing after it', () => {
    expect(readEventStream('data:\n\ndata: {"a":1}\n\n')).toEqual(['{"a":1}']);
  });

  it('ignores comments, retry directives, and blank lines', () => {
    const body = ': keep-alive\nretry: 1000\n\nevent: ping\n\ndata: {"a":1}\n';

    expect(readEventStream(body)).toEqual(['{"a":1}']);
  });

  it('returns nothing for a body carrying no data field', () => {
    expect(readEventStream('event: message\nid: 1\n\n')).toEqual([]);
    expect(readEventStream('')).toEqual([]);
  });
});

describe('isEventStream', () => {
  it('recognises the content type with parameters attached', () => {
    expect(isEventStream('text/event-stream; charset=utf-8')).toBe(true);
  });

  it('is case insensitive, since header values are not normalised', () => {
    expect(isEventStream('Text/Event-Stream')).toBe(true);
  });

  it('rejects JSON and a missing header', () => {
    expect(isEventStream('application/json')).toBe(false);
    expect(isEventStream(undefined)).toBe(false);
  });
});
