import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTOR_TYPE,
  DECISION_EFFECT,
  ENFORCEMENT_MODE,
  EVENT_SCHEMA_VERSION,
  EVENT_SURFACE,
  MEMNOX_HOME,
  SqliteEventStore,
  TOOL_CLASS,
  type MemnoxEvent,
} from '@memnox/core';
import { registerClaimsCommand } from '../src/commands/claims.command';
import { runCommand } from './cli-harness';

const NOW = '2026-09-05T10:00:00.000Z';

const event = (over: Partial<MemnoxEvent>): MemnoxEvent => ({
  id: `evt_${Math.random().toString(36).slice(2, 12)}`,
  schemaVersion: EVENT_SCHEMA_VERSION,
  at: NOW,
  sessionId: 'ses_1',
  agent: 'claude-code',
  actorType: ACTOR_TYPE.AGENT,
  surface: EVENT_SURFACE.SHELL,
  operation: 'npm.test',
  class: TOOL_CLASS.READ,
  effect: DECISION_EFFECT.ALLOW,
  mode: ENFORCEMENT_MODE.ENFORCE,
  reason: 'ok',
  ...over,
});

async function machine(transcript: string, events: MemnoxEvent[]) {
  const home = await mkdtemp(join(tmpdir(), 'memnox-claims-'));
  await mkdir(join(home, MEMNOX_HOME, 'transcripts'), { recursive: true });
  await writeFile(join(home, MEMNOX_HOME, 'transcripts', 'ses_1.log'), transcript);

  const store = SqliteEventStore.forHome(home);
  for (const each of events) await store.append(each);
  store.close();
  return home;
}

const claims = (home: string, args: string[]) =>
  runCommand(
    (program, context) => registerClaimsCommand(program, context, () => home),
    args,
  );

describe('memnox claims', () => {
  it('contradicts a claim the record shows failing', async () => {
    const home = await machine('All tests passed, we are good to ship.', [
      event({ operation: 'npm.test', exitCode: 1 }),
    ]);

    const { out } = await claims(home, ['claims', 'ses_1']);
    expect(out.text).toContain('tests passed');
    expect(out.text).toContain('did not succeed');
  });

  it('supports a claim the record backs up', async () => {
    const home = await machine('Tests passed.', [
      event({ operation: 'npm.test', exitCode: 0 }),
    ]);

    const { out } = await claims(home, ['claims', 'ses_1']);
    expect(out.text).toContain('matching action');
  });

  /* "Unsupported" is not "untrue", and a screen that let people read it as one would
     be making an accusation out of a gap in what this machine can see. */
  it('says plainly that unsupported is not a finding of dishonesty', async () => {
    const home = await machine('I deployed it to staging.', []);
    const { out } = await claims(home, ['claims', 'ses_1']);
    expect(out.notes.join(' ')).toContain('not that it did not happen');
  });

  it('reads a file when there is no transcript', async () => {
    const home = await machine('nothing here', []);
    const path = join(home, 'notes.txt');
    await writeFile(path, 'Tests passed.');

    const { out } = await claims(home, ['claims', '--file', path]);
    expect(out.text).toContain('tests');
  });

  it('says how to get a transcript rather than failing silently', async () => {
    const home = await machine('x', []);
    await expect(claims(home, ['claims', 'ses_missing'])).rejects.toThrow('--transcript');
  });

  it('reports nothing when the text makes no claims at all', async () => {
    const home = await machine('Looking at the repository now.', []);
    const { out } = await claims(home, ['claims', 'ses_1']);
    expect(out.text).toContain('reads as a claim');
  });
});
