import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CloudNotes, renderNotes } from '../src/coordination/session-notes';
import { MEMNOX_HOME } from '../src/config/config';

async function enrolled(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'memnox-notes-'));
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

/* What somebody said to this session, collected at its next pause on its own
   move, and nothing at all when nobody could be asked. */
describe('collecting what was said to a session', () => {
  it('asks for this agent and this session, and keeps who said it', async () => {
    const asked: { url: string; body: unknown }[] = [];
    const notes = new CloudNotes(await enrolled(), (async (
      url: string,
      init: { body: string },
    ) => {
      asked.push({ url, body: JSON.parse(init.body) });
      return new Response(
        JSON.stringify({
          commands: [
            {
              id: 'n1',
              message: 'codex on vps tried to edit retryCharge',
              issuedBy: 'memnox',
              issuedAt: '2026-09-22T10:00:00.000Z',
              kind: 'coordination',
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch);

    const found = await notes.collect('claude-code', 'ses-1');

    expect(asked[0]?.url).toBe(
      'https://control.example.com/v1/workspaces/acme/agents/claude-code/control/drain',
    );
    expect(asked[0]?.body).toEqual({ session: 'ses-1' });
    expect(found).toEqual([
      {
        id: 'n1',
        message: 'codex on vps tried to edit retryCharge',
        issuedBy: 'memnox',
        issuedAt: '2026-09-22T10:00:00.000Z',
        kind: 'coordination',
      },
    ]);
  });

  it('has nothing when the control plane cannot be reached, or with no account', async () => {
    const failing = new CloudNotes(await enrolled(), (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch);
    expect(await failing.collect('claude-code', 'ses-1')).toEqual([]);

    const home = await mkdtemp(join(tmpdir(), 'memnox-notes-'));
    expect(await new CloudNotes(home).collect('claude-code', 'ses-1')).toEqual([]);
  });

  /* A model that cannot tell a note from its own user's words would weigh it as
     either, so it is named as coming from outside the conversation. */
  it('reads as information from outside the conversation, naming who said it', () => {
    const text = renderNotes([
      { id: 'a', message: 'wrap up', issuedBy: 'ada', issuedAt: '' },
      { id: 'b', message: 'codex wants these lines', issuedBy: 'memnox', issuedAt: '' },
    ]);

    expect(text).toContain('not permission');
    expect(text).toContain('- From ada, through Memnox: wrap up');
    expect(text).toContain('- From Memnox, about another agent: codex wants these lines');
  });
});
