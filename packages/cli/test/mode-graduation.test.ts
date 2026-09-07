import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ENFORCEMENT_MODE,
  configPathFor,
  loadOrCreateConfig,
  readAccount,
  saveConfig,
  writeAccount,
  type Account,
} from '@memnox/core';
import { onePass } from '../src/sync/heartbeat';

/**
 * Moving a machine along the ramp from the control plane.
 *
 * The mode is applied here, on this machine, and the reply carries the
 * workspace's on every pass — so the whole design is that a *change* lands and a
 * repetition does not. A version of this that wrote the reply each time would
 * revert an edit somebody made to `config.toml` within a minute, for ever, on a
 * file whose first line says it is theirs to edit.
 */
const BASE = 'https://cloud.test';

/* A real key: the skills and census pushes on the same pass sign their bodies,
   and a placeholder fails in the signer rather than in what is under test. */
const PRIVATE_KEY = generateKeyPairSync('ed25519')
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

interface Beat {
  mode?: string;
  runtimeVersion?: string;
}

describe('a mode set in the workspace', () => {
  let home: string;
  let beats: Beat[];
  let reply: { mode?: string };

  const account = (over: Partial<Account> = {}): Account => ({
    version: 1,
    baseUrl: BASE,
    workspaceId: 'acme',
    machineId: 'mch_1',
    token: 'machine-token',
    privateKey: PRIVATE_KEY,
    enrolledAt: '2026-09-05T10:00:00.000Z',
    ...over,
  });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'memnox-mode-'));
    beats = [];
    reply = {};
    vi.stubGlobal('fetch', (async (url: URL | string, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/heartbeat')) {
        const body = init === undefined ? '{}' : String(init.body);
        beats.push(JSON.parse(body) as Beat);
        return new Response(JSON.stringify({ id: 'mch_1', ...reply }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // The bundle is unchanged and every push has nothing to say.
      if (path.includes('/bundle')) return new Response(null, { status: 304 });
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(home, { recursive: true, force: true });
  });

  /* The fleet page shows what is asked for beside what is running, and it can
     only do that if the machine says which it is. */
  it('reports the mode this machine is actually running', async () => {
    await writeAccount(home, account());
    await saveConfig(home, {
      ...(await loadOrCreateConfig(home)),
      mode: ENFORCEMENT_MODE.ADVISE,
    });

    await onePass(home);

    expect(beats).toHaveLength(1);
    expect(beats[0]?.mode).toBe(ENFORCEMENT_MODE.ADVISE);
  });

  it('graduates the machine when the workspace says enforce', async () => {
    await writeAccount(home, account({ cloudMode: ENFORCEMENT_MODE.OBSERVE }));
    reply = { mode: ENFORCEMENT_MODE.ENFORCE };

    await onePass(home);

    expect((await loadOrCreateConfig(home)).mode).toBe(ENFORCEMENT_MODE.ENFORCE);
    expect((await readAccount(home))?.cloudMode).toBe(ENFORCEMENT_MODE.ENFORCE);
  });

  /* The valve. A rule set that breaks the build at two in the morning is fixed
     by going back to observe, and needing to SSH to every box to do it is how it
     gets done by uninstalling instead. */
  it('takes it back down again', async () => {
    await writeAccount(home, account({ cloudMode: ENFORCEMENT_MODE.ENFORCE }));
    await saveConfig(home, {
      ...(await loadOrCreateConfig(home)),
      mode: ENFORCEMENT_MODE.ENFORCE,
    });
    reply = { mode: ENFORCEMENT_MODE.OBSERVE };

    await onePass(home);

    expect((await loadOrCreateConfig(home)).mode).toBe(ENFORCEMENT_MODE.OBSERVE);
  });

  /* The one that matters. The reply says the same thing every minute; only a
     change is a decision, and everything else is somebody's own config. */
  it('leaves a local edit alone while the workspace has not changed its mind', async () => {
    await writeAccount(home, account({ cloudMode: ENFORCEMENT_MODE.ENFORCE }));
    reply = { mode: ENFORCEMENT_MODE.ENFORCE };

    await onePass(home);
    await saveConfig(home, {
      ...(await loadOrCreateConfig(home)),
      mode: ENFORCEMENT_MODE.OBSERVE,
    });
    await onePass(home);

    expect((await loadOrCreateConfig(home)).mode).toBe(ENFORCEMENT_MODE.OBSERVE);
    expect(beats[1]?.mode).toBe(ENFORCEMENT_MODE.OBSERVE);
  });

  /* A word from a newer control plane than this binary is not a mode the gate
     can read, and writing it into the file would leave one it cannot parse. */
  it('ignores a mode it has no name for', async () => {
    await writeAccount(home, account({ cloudMode: ENFORCEMENT_MODE.OBSERVE }));
    reply = { mode: 'supervised' };

    await onePass(home);

    expect((await loadOrCreateConfig(home)).mode).toBe(ENFORCEMENT_MODE.OBSERVE);
    expect(await readFile(configPathFor(home), 'utf8')).not.toContain('supervised');
  });

  /* Not logged in is the ordinary state, and it makes no call at all. */
  it('does nothing on a machine with no account', async () => {
    await onePass(home);
    expect(beats).toEqual([]);
  });
});
