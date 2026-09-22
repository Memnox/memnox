import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  actionFingerprint,
  CLAIM_ANSWER,
  CLAIM_WINDOW_MS,
  CloudActions,
  keepClaimed,
  type SharedActions,
} from '../src/coordination/shared-actions';
import { MEMNOX_HOME } from '../src/config/config';
import type { LeaseHolder } from '../src/coordination/lease';

const holder: LeaseHolder = { agent: 'hermes', sessionId: 'ses_a', pid: 111 };

async function enrolled(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'memnox-actions-'));
  await mkdir(join(home, MEMNOX_HOME), { recursive: true });
  await writeFile(
    join(home, MEMNOX_HOME, 'account.json'),
    JSON.stringify({
      version: 1,
      baseUrl: 'https://control.example.com',
      workspaceId: 'acme',
      machineId: 'mch_1',
      token: 'mch_token',
      privateKey: 'pem',
      enrolledAt: '2026-09-22T10:00:00.000Z',
    }),
  );
  return home;
}

const answering = (status: number, body: unknown, seen: unknown[] = []) =>
  (async (_url: string, init: { body: string }) => {
    seen.push(JSON.parse(init.body));
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;

const message = {
  operation: 'slack.send_message',
  target: '#general',
  arguments: { text: 'deploy is done' },
};

describe('what an agent sends before it acts', () => {
  /* Names and a digest, never the message itself: the same bargain the ledger
     makes, and the reason this can sit in front of an outward call at all. */
  it('sends a digest of the arguments and never the arguments', async () => {
    const seen: unknown[] = [];
    const actions = new CloudActions(
      await enrolled(),
      answering(200, { outcome: 'claimed' }, seen),
    );

    await actions.claim(message, holder);

    expect(seen[0]).toEqual({
      fingerprint: actionFingerprint(message),
      operation: 'slack.send_message',
      target: '#general',
      holder: { agent: 'hermes', session: 'ses_a', machine: 'mch_1' },
      ttlMs: CLAIM_WINDOW_MS,
    });
    expect(JSON.stringify(seen[0])).not.toContain('deploy is done');
  });

  /* A claim means "doing this now", so the window is seconds and the seam says
     when the work is done rather than leaving it to lapse. */
  it('asks for a window of seconds, and finishes with the digest alone', async () => {
    expect(CLAIM_WINDOW_MS).toBeLessThanOrEqual(30_000);
    const seen: unknown[] = [];
    const actions = new CloudActions(await enrolled(), answering(200, {}, seen));

    await actions.finish(message, holder);

    expect(seen[0]).toEqual({
      fingerprint: actionFingerprint(message),
      holder: { agent: 'hermes', session: 'ses_a', machine: 'mch_1' },
    });
    expect(JSON.stringify(seen[0])).not.toContain('deploy is done');
  });

  it('renews a claim while the work runs and finishes it once', async () => {
    let claims = 0;
    let finishes = 0;
    const actions: SharedActions = {
      claim: async () => {
        claims += 1;
        return { answer: CLAIM_ANSWER.MINE };
      },
      finish: async () => {
        finishes += 1;
      },
    };

    const release = keepClaimed(actions, message, holder, 5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await release();
    await release();
    const renewed = claims;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(renewed).toBeGreaterThan(0);
    expect(claims).toBe(renewed);
    expect(finishes).toBe(1);
  });

  it('names who already has it', async () => {
    const actions = new CloudActions(
      await enrolled(),
      answering(200, {
        outcome: 'duplicate',
        by: {
          agent: 'claude-code',
          machine: 'ana-laptop',
          at: '2026-09-22T10:00:00.000Z',
          operation: 'slack.send_message',
        },
      }),
    );

    const outcome = await actions.claim(message, holder);

    expect(outcome.answer).toBe(CLAIM_ANSWER.DUPLICATE);
    if (outcome.answer !== CLAIM_ANSWER.DUPLICATE) return;
    expect(outcome.agent).toBe('claude-code');
    expect(outcome.machine).toBe('ana-laptop');
  });

  it('answers unknown rather than taken when nobody could be asked', async () => {
    const unenrolled = new CloudActions(
      await mkdtemp(join(tmpdir(), 'memnox-actions-')),
      answering(200, { outcome: 'claimed' }),
    );
    expect((await unenrolled.claim(message, holder)).answer).toBe(CLAIM_ANSWER.UNKNOWN);

    const refused = new CloudActions(await enrolled(), answering(403, {}));
    expect((await refused.claim(message, holder)).answer).toBe(CLAIM_ANSWER.UNKNOWN);
  });

  /* Two different messages are two pieces of work: this never decides that two
     things mean the same thing. */
  it('fingerprints the same call the same way and a different one differently', () => {
    expect(actionFingerprint(message)).toBe(
      actionFingerprint({
        operation: 'slack.send_message',
        target: '#general',
        arguments: { text: 'deploy is done' },
      }),
    );
    expect(actionFingerprint(message)).not.toBe(
      actionFingerprint({ ...message, arguments: { text: 'deploy failed' } }),
    );
  });
});
