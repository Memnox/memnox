import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTOR_TYPE,
  DECISION_EFFECT,
  ENFORCEMENT_MODE,
  EVENT_SCHEMA_VERSION,
  EVENT_SURFACE,
  SessionPauses,
  SqliteEventStore,
  TOOL_CLASS,
  type MemnoxEvent,
} from '@memnox/core';
import { observeSession, pauseHolding } from '../src/breaker-seam';

const SESSION = 'ses_loop';
const at = (minute: number): string =>
  new Date(Date.parse('2026-09-05T10:00:00.000Z') + minute * 60_000).toISOString();

const failure = (minute: number): MemnoxEvent => ({
  id: `evt_${minute}`,
  schemaVersion: EVENT_SCHEMA_VERSION,
  at: at(minute),
  sessionId: SESSION,
  agent: 'claude-code',
  actorType: ACTOR_TYPE.AGENT,
  surface: EVENT_SURFACE.SHELL,
  operation: 'npm.test',
  class: TOOL_CLASS.READ,
  effect: DECISION_EFFECT.ALLOW,
  mode: ENFORCEMENT_MODE.ENFORCE,
  reason: 'ran',
  exitCode: 1,
});

async function machine(failures: number): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'memnox-breaker-seam-'));
  const store = SqliteEventStore.forHome(home);
  for (let i = 0; i < failures; i += 1) await store.append(failure(i));
  store.close();
  return home;
}

describe('the breaker, replayed at the seam', () => {
  it('holds a session that has failed the same way five times', async () => {
    const home = await machine(5);
    const tripped = await observeSession({ home, sessionId: SESSION });

    expect(tripped?.signal).toBe('error-loop');
    expect(await pauseHolding(home, SESSION)).not.toBeNull();
  });

  it('leaves a session that is still getting somewhere alone', async () => {
    const home = await machine(3);
    expect(await observeSession({ home, sessionId: SESSION })).toBeNull();
  });

  /* Lifting a hold is somebody saying "carry on from here". Replaying the whole
     ledger meant the failures that caused the pause were still in it, so the first
     command after `memnox resume` re-tripped the breaker on the same five failures
     and the session could never actually be resumed. */
  it('does not trip again on the failures a person has already let go', async () => {
    const home = await machine(5);
    await observeSession({ home, sessionId: SESSION });
    await new SessionPauses(home).resume(SESSION, 'tresor', at(10));

    expect(await observeSession({ home, sessionId: SESSION })).toBeNull();
    expect(await pauseHolding(home, SESSION)).toBeNull();
  });

  it('holds again when the same thing starts failing after a resume', async () => {
    const home = await machine(5);
    await observeSession({ home, sessionId: SESSION });
    await new SessionPauses(home).resume(SESSION, 'tresor', at(10));

    const store = SqliteEventStore.forHome(home);
    for (let i = 20; i < 25; i += 1) await store.append(failure(i));
    store.close();

    expect(await observeSession({ home, sessionId: SESSION })).not.toBeNull();
  });

  it('says nothing about a run with no session to attribute it to', async () => {
    const home = await machine(5);
    expect(await observeSession({ home, sessionId: undefined })).toBeNull();
    expect(await pauseHolding(home, undefined)).toBeNull();
  });
});
