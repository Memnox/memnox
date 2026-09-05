import { describe, expect, it } from 'vitest';
import {
  EVENT_SCHEMA,
  EVENT_SCHEMA_VERSION,
  isMemnoxEvent,
  validateEvent,
  type MemnoxEvent,
} from '../src/event/index';

const VALID: MemnoxEvent = {
  id: 'evt_1',
  schemaVersion: EVENT_SCHEMA_VERSION,
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
};

describe('the frozen event schema', () => {
  it('accepts a well-formed event', () => {
    expect(validateEvent(VALID)).toEqual([]);
    expect(isMemnoxEvent(VALID)).toBe(true);
  });

  it('names every missing field at once, not the first', () => {
    const problems = validateEvent({ id: 'x' });
    expect(problems.length).toBeGreaterThan(5);
    expect(problems).toContain('agent is required');
    expect(problems).toContain('effect is required');
  });

  it('refuses a field that is not part of v1, so drift is caught at the boundary', () => {
    expect(validateEvent({ ...VALID, sneaky: 'value' })).toContain(
      'sneaky is not a field of v1',
    );
  });

  it('refuses a version that is not the frozen one', () => {
    expect(validateEvent({ ...VALID, schemaVersion: 2 })).toContain(
      'schemaVersion must be 1',
    );
  });

  it.each([
    ['effect', 'maybe'],
    ['surface', 'telepathy'],
    ['mode', 'sometimes'],
    ['actorType', 'ghost'],
    ['class', 'purple'],
  ])('refuses an unknown %s', (field, value) => {
    const problems = validateEvent({ ...VALID, [field]: value });
    expect(problems.some((each) => each.startsWith(field))).toBe(true);
  });

  it('refuses a timestamp that is not one', () => {
    expect(validateEvent({ ...VALID, at: 'last tuesday' })).toContain(
      'at must be an ISO 8601 timestamp',
    );
  });

  it('catches a payload that escaped into a digest field', () => {
    const leaked = { ...VALID, argsDigest: 'x'.repeat(200) };
    expect(validateEvent(leaked)).toContain(
      'argsDigest looks like content rather than a digest',
    );
  });

  it('publishes a schema whose required list matches what validate enforces', () => {
    const problems = validateEvent({});
    for (const key of EVENT_SCHEMA.required) {
      expect(problems).toContain(`${key} is required`);
    }
  });

  it('is frozen at v1, so the cloud can ingest against it', () => {
    expect(EVENT_SCHEMA.$id).toBe('https://memnox.dev/schema/event-v1.json');
    expect(EVENT_SCHEMA.properties.schemaVersion.const).toBe(1);
  });
});
