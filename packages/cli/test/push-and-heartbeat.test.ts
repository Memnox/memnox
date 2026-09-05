import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACTOR_TYPE,
  DECISION_EFFECT,
  ENFORCEMENT_MODE,
  EVENT_SCHEMA_VERSION,
  EVENT_SURFACE,
  TOOL_CLASS,
  type MemnoxEvent,
} from '@memnox/core';
import { draftFrom, readCursor, signBody } from '../src/sync/push';
import { syncLoop, type Pass } from '../src/sync/heartbeat';

const event = (over: Partial<MemnoxEvent> = {}): MemnoxEvent => ({
  id: 'evt_1',
  schemaVersion: EVENT_SCHEMA_VERSION,
  at: '2026-09-05T12:00:00.000Z',
  sessionId: 'ses_1',
  agent: 'claude-code',
  actorType: ACTOR_TYPE.AGENT,
  surface: EVENT_SURFACE.SHELL,
  operation: 'git.push',
  class: TOOL_CLASS.WRITE,
  effect: DECISION_EFFECT.DENY,
  mode: ENFORCEMENT_MODE.ENFORCE,
  reason: 'main is shared',
  argsDigest: 'abc123',
  ...over,
});

describe('the batch a machine sends', () => {
  /* The id is what the control plane deduplicates on, so a resend after a crash
     between "posted" and "recorded" costs a comparison rather than a second row. */
  it('keys every event on the id that survives a resend', () => {
    expect(draftFrom(event()).dedupKey).toBe('evt_1');
  });

  /* The kind the control plane's activity projection reads. Naming the surface
     instead landed every row in the log and projected none of them: stored, and
     invisible to everything that reads them. */
  it('names the kind the projection builds a timeline from', () => {
    expect(draftFrom(event()).kind).toBe('agent.action.recorded');
  });

  // `decisions` and `results` are keyed on the action, not on what it touched.
  it('carries the action id as the subject the other tables key on', () => {
    expect(draftFrom(event()).subjectId).toBe('evt_1');
  });

  it('uses the field names the projection reads, not its own', () => {
    const payload = draftFrom(event({ target: 'main' })).payload as Record<
      string,
      unknown
    >;

    expect(payload['resourceRef']).toBe('main');
    expect(payload['classes']).toEqual(['write']);
    expect(payload['effect']).toBe('deny');
  });

  // A refused action never ran; a result row for it would say it completed.
  it('sends no outcome for something that never ran', () => {
    const payload = draftFrom(event()).payload as Record<string, unknown>;

    expect(payload['exitCode']).toBeUndefined();
  });

  it('sends the outcome when there was one', () => {
    const payload = draftFrom(event({ exitCode: 1, durationMs: 20 })).payload as Record<
      string,
      unknown
    >;

    expect(payload['exitCode']).toBe(1);
    expect(payload['errored']).toBe(true);
    expect(payload['startedAt']).toBe(Date.parse('2026-09-05T12:00:00.000Z') - 20);
  });

  it('sends epoch milliseconds, which is what the ingest door reads', () => {
    expect(draftFrom(event()).occurredAt).toBe(Date.parse('2026-09-05T12:00:00.000Z'));
  });

  // A digest travels; the arguments never do.
  it('carries no argument values', () => {
    const draft = JSON.stringify(draftFrom(event({ target: '/etc/passwd' })));

    expect(draft).toContain('abc123');
    expect(draft).not.toContain('"arguments"');
  });
});

describe('signing a batch', () => {
  /* Over the exact bytes posted. Serialising twice would sign one string and
     send another, and the signature would never verify. */
  it('verifies against the public half of the machine key', () => {
    const pair = generateKeyPairSync('ed25519');
    const privateKey = pair.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const body = JSON.stringify({ events: [draftFrom(event())] });

    const signature = signBody(privateKey, body);

    expect(
      verify(
        null,
        Buffer.from(body, 'utf8'),
        pair.publicKey,
        Buffer.from(signature, 'base64'),
      ),
    ).toBe(true);
  });

  it('does not verify against a different body', () => {
    const pair = generateKeyPairSync('ed25519');
    const privateKey = pair.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();

    const signature = signBody(privateKey, '{"events":[]}');

    expect(
      verify(
        null,
        Buffer.from('{"events":[{}]}', 'utf8'),
        pair.publicKey,
        Buffer.from(signature, 'base64'),
      ),
    ).toBe(false);
  });
});

describe('the cursor', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'memnox-push-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('starts empty, which is where every machine starts', async () => {
    expect(await readCursor(home)).toEqual({});
  });
});

describe('the loop the daemon runs', () => {
  const passes = (results: Pass[]): ((home: string) => Promise<Pass>) => {
    let index = 0;
    return async () => results[index++] ?? {};
  };

  it('keeps going while it is running', async () => {
    const slept: number[] = [];
    let left = 3;

    await syncLoop('/home', () => left-- > 0, {
      pass: passes([{}, {}, {}]),
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    expect(slept).toHaveLength(3);
  });

  /* The one thing that stops it. Everything else is a laptop with its lid shut,
     and a loop that gave up on that would need somebody to notice and restart it. */
  it('stops when the machine has been revoked', async () => {
    const said: string[] = [];

    await syncLoop('/home', () => true, {
      pass: passes([{ revoked: true }]),
      sleep: async () => {},
      log: (message) => said.push(message),
    });

    expect(said.join(' ')).toContain('revoked');
  });

  it('backs off rather than hammering an unreachable control plane', async () => {
    const slept: number[] = [];
    let left = 2;

    await syncLoop('/home', () => left-- > 0, {
      pass: passes([{ unreachable: true }, {}]),
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    expect(slept[0]).toBeGreaterThan(slept[1] as number);
  });

  // A pass that throws must not end the daemon; the gate is what matters.
  it('survives a pass that throws', async () => {
    let left = 2;
    const said: string[] = [];

    await syncLoop('/home', () => left-- > 0, {
      pass: async () => {
        throw new Error('sqlite is locked');
      },
      sleep: async () => {},
      log: (message) => said.push(message),
    });

    expect(said).toContain('sqlite is locked');
  });
});
