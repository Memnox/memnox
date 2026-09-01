import { describe, expect, it } from 'vitest';
import { CONTAINMENT_KIND, EMPTY_CONTAINMENT_EFFECTS } from '@memnox/core';
import { FakeRuntime, runCli } from './cli-harness';

const CONTAIN_PATH = '/v1/containment';
const AGENT = 'agt_1';

const action = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'con_1',
  workspaceId: 'local',
  kind: CONTAINMENT_KIND.KILL,
  subjectId: AGENT,
  reason: 'it reached production',
  authorId: 'tresor',
  at: '2026-09-01T02:00:00.000Z',
  effects: { ...EMPTY_CONTAINMENT_EFFECTS, installsReached: 1, credentialsHeld: 1 },
  unreached: [],
  ...over,
});

describe('memnox kill', () => {
  it('says the credential was suspended, and how to undo it', async () => {
    const runtime = new FakeRuntime().on('POST', CONTAIN_PATH, action());

    const { out } = await runCli(
      ['kill', AGENT, '--reason', 'it reached production', '--by', 'tresor'],
      runtime,
    );

    expect(out.text).toContain('credential          suspended');
    expect(out.text).toContain('Held, and every machine acknowledged it.');
    expect(out.notes.join('\n')).toContain(`memnox agents activate ${AGENT}`);
    expect(process.exitCode ?? 0).toBe(0);
  });

  /* Revoking leases and closing seams leaves the agent's own token answering, so a
     containment reported as done is one the next request walks straight past. */
  it('refuses to report a kill it did not make, and exits non-zero', async () => {
    const runtime = new FakeRuntime().on(
      'POST',
      CONTAIN_PATH,
      action({ effects: { ...EMPTY_CONTAINMENT_EFFECTS, installsReached: 1 } }),
    );

    try {
      const { out } = await runCli(
        ['kill', AGENT, '--reason', 'it reached production', '--by', 'tresor'],
        runtime,
      );

      expect(out.text).toContain('NOT held');
      expect(out.text).toContain('THE AGENT IS NOT HELD');
      expect(out.text).not.toContain('acknowledged it');
      expect(process.exitCode).toBe(4);
    } finally {
      process.exitCode = 0;
    }
  });
});

describe('memnox quarantine', () => {
  it('says the credential is held read-only, in its own words', async () => {
    const runtime = new FakeRuntime().on(
      'POST',
      CONTAIN_PATH,
      action({ kind: CONTAINMENT_KIND.QUARANTINE }),
    );

    const { out } = await runCli(
      ['quarantine', AGENT, '--reason', 'behaving oddly', '--by', 'tresor'],
      runtime,
    );

    expect(out.text).toContain('credential          held read-only');
    expect(out.text).toContain('Read-only, and every machine acknowledged it.');
  });
});

describe('memnox panic', () => {
  // Raising every environment is the whole of what panic does; it was the one effect
  // the report left out, so the screen was three zeros and a success line.
  it('prints the environments it raised', async () => {
    const runtime = new FakeRuntime().on(
      'POST',
      CONTAIN_PATH,
      action({
        kind: CONTAINMENT_KIND.PANIC,
        subjectId: undefined,
        effects: {
          ...EMPTY_CONTAINMENT_EFFECTS,
          installsReached: 1,
          environmentsRaised: 3,
        },
      }),
    );

    const { out } = await runCli(
      [
        'panic',
        '--reason',
        'incident 928',
        '--by',
        'tresor',
        '--restore',
        'memnox reload',
      ],
      runtime,
    );

    expect(out.text).toContain('environments raised 3');
    // No subject, so there is no credential line to print.
    expect(out.text).not.toContain('credential ');
  });
});
