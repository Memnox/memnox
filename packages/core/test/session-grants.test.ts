import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileGrants } from '../src/gate/session-grants';

const SUBJECT = {
  sessionId: 'ses_1',
  operation: 'gh.pr-view',
  fingerprint: 'gh pr view 12',
  class: 'read',
};

describe('session grants on disk', () => {
  it('are read by the next process, which is every hook', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-grants-'));
    await new FileGrants(home).grant(SUBJECT);

    const nextProcess = new FileGrants(home);
    expect(await nextProcess.covers({ ...SUBJECT, fingerprint: 'gh pr view 13' })).toBe(
      true,
    );
    expect(await nextProcess.covers({ ...SUBJECT, sessionId: 'ses_2' })).toBe(false);
  });

  it('count yeses across processes, and learn on the second', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-grants-'));
    expect(await new FileGrants(home).approved(SUBJECT)).toBe(false);
    expect(await new FileGrants(home).approved(SUBJECT)).toBe(true);
    expect(await new FileGrants(home).covers(SUBJECT)).toBe(true);
  });

  it('keep a session id from naming a file outside the grants directory', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-grants-'));
    const escaping = { ...SUBJECT, sessionId: '../../etc/x' };
    await new FileGrants(home).grant(escaping);
    expect(await new FileGrants(home).covers(escaping)).toBe(true);
  });
});
