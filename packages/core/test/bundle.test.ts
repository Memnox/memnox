import { describe, expect, it } from 'vitest';
import {
  buildBundle,
  generateKeys,
  serializeEvents,
  verifyBundle,
  VERIFY_RESULT,
} from '../src/event/bundle';
import type { MemnoxEvent } from '../src/event/event';

const event = (id: string): MemnoxEvent => ({
  id,
  schemaVersion: 1,
  at: '2026-09-05T10:00:00.000Z',
  sessionId: 'ses_1',
  agent: 'claude-code',
  actorType: 'agent',
  surface: 'mcp',
  operation: 'github.merge_pull_request',
  class: 'write',
  effect: 'deny',
  mode: 'enforce',
  reason: 'production is frozen',
});

const RANGE = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-05T23:59:59.000Z' };
const build = (events: MemnoxEvent[], keys = generateKeys()) =>
  buildBundle({ events, range: RANGE, createdAt: '2026-09-05T12:00:00.000Z', keys });

describe('a signed bundle', () => {
  it('verifies when nothing has been touched', () => {
    const { header, body } = build([event('a'), event('b')]);
    const check = verifyBundle(header, body);

    expect(check.result).toBe(VERIFY_RESULT.VALID);
    expect(check.detail).toContain('2 event(s)');
    expect(check.detail).toContain('signature checks out');
  });

  it('says which period it covers, because an export that did not would be worse than none', () => {
    const { header } = build([event('a')]);
    expect(header.range).toEqual(RANGE);
    expect(header.events).toBe(1);
  });

  it('catches an edited event', () => {
    const { header, body } = build([event('a')]);
    const tampered = body.replace('"deny"', '"allow"');

    expect(verifyBundle(header, tampered).result).toBe(VERIFY_RESULT.TAMPERED);
    expect(verifyBundle(header, tampered).detail).toContain('has been edited');
  });

  it('catches a removed event, which is the quiet way to edit history', () => {
    const { header, body } = build([event('a'), event('b')]);
    const shortened = body.split('\n').slice(0, 1).join('\n');
    expect(verifyBundle(header, shortened).result).toBe(VERIFY_RESULT.TAMPERED);
  });

  it('catches an edited header, so the range cannot be widened after the fact', () => {
    const { header, body } = build([event('a')]);
    const widened = { ...header, range: { ...RANGE, to: '2027-01-01T00:00:00.000Z' } };
    expect(verifyBundle(widened, body).result).toBe(VERIFY_RESULT.FORGED);
  });

  it('catches a count that does not match the events', () => {
    const { header, body } = build([event('a')]);
    expect(verifyBundle({ ...header, events: 99 }, body).result).toBe(
      VERIFY_RESULT.FORGED,
    );
  });

  it('catches a signature made with a different key', () => {
    const { header, body } = build([event('a')]);
    const other = build([event('a')], generateKeys());
    expect(
      verifyBundle({ ...header, signature: other.header.signature }, body).result,
    ).toBe(VERIFY_RESULT.FORGED);
  });

  it('reads as unsigned rather than valid when nothing signed it', () => {
    const unsigned = buildBundle({
      events: [event('a')],
      range: RANGE,
      createdAt: '2026-09-05T12:00:00.000Z',
    });
    const check = verifyBundle(unsigned.header, unsigned.body);

    expect(check.result).toBe(VERIFY_RESULT.UNSIGNED);
    expect(check.detail).toContain('nothing signed it');
  });

  it('reports tampering ahead of missing signature, because content matters more', () => {
    const unsigned = buildBundle({
      events: [event('a')],
      range: RANGE,
      createdAt: '2026-09-05T12:00:00.000Z',
    });
    expect(verifyBundle(unsigned.header, 'edited').result).toBe(VERIFY_RESULT.TAMPERED);
  });

  it('names what was left out rather than dropping it silently', () => {
    const { header } = buildBundle({
      events: [event('a')],
      range: RANGE,
      createdAt: '2026-09-05T12:00:00.000Z',
      excluded: ['3 events already purged by retention'],
    });
    expect(header.excluded[0]).toContain('purged by retention');
  });

  it('travels with its public key, so a verifier needs nothing from us', () => {
    const { header } = build([event('a')]);
    expect(header.publicKey).toContain('BEGIN PUBLIC KEY');
    expect(JSON.stringify(header)).not.toContain('PRIVATE KEY');
  });

  it('serializes one event per line, in order', () => {
    expect(serializeEvents([event('a'), event('b')]).split('\n')).toHaveLength(2);
  });
});
