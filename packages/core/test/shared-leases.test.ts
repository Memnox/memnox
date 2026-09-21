import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CloudLeases, SHARED_OUTCOME } from '../src/coordination/shared-leases';
import { MEMNOX_HOME } from '../src/config/config';
import type { LeaseHolder } from '../src/coordination/lease';

const holder: LeaseHolder = { agent: 'hermes', sessionId: 'ses_a', pid: 111 };

async function enrolled(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'memnox-shared-'));
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
      enrolledAt: '2026-09-05T10:00:00.000Z',
    }),
  );
  return home;
}

const answering = (status: number, body: unknown): typeof globalThis.fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;

describe('what the workspace says about a path', () => {
  it('takes it when the control plane grants it', async () => {
    const leases = new CloudLeases(await enrolled(), answering(201, { id: 'lse_1' }));
    expect((await leases.take('src/billing', holder, 30)).outcome).toBe(
      SHARED_OUTCOME.TAKEN,
    );
  });

  it('names the repository the path is in, where it was built with one', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetcher = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: 'lse_1' }), { status: 201 });
    }) as unknown as typeof globalThis.fetch;
    const home = await enrolled();

    await new CloudLeases(home, fetcher, 1_000, 'api').take('src/a.ts', holder, 30);
    await new CloudLeases(home, fetcher).take('src/a.ts', holder, 30);

    expect(bodies.map((body) => body['repository'])).toEqual(['api', undefined]);
  });

  it('names the holder and the machine when another one has it', async () => {
    const leases = new CloudLeases(
      await enrolled(),
      answering(409, {
        message: 'cursor has src/billing',
        holding: { path: 'src/billing', holder: { agent: 'cursor', machine: 'vps-2' } },
      }),
    );
    const result = await leases.take('src/billing', holder, 30);

    expect(result.outcome).toBe(SHARED_OUTCOME.HELD_BY_ANOTHER);
    if (result.outcome !== SHARED_OUTCOME.HELD_BY_ANOTHER) return;
    expect(result.holder).toBe('cursor');
    expect(result.machine).toBe('vps-2');
  });

  /* A real answer from a Free workspace, which is the default every install starts on.
     Shared leases are a paid feature, and a machine that read the refusal as "held"
     would stop every write on a plan that never promised the register at all. */
  it('reads a plan refusal as nobody could tell me, not as held', async () => {
    const leases = new CloudLeases(
      await enrolled(),
      answering(403, {
        message: 'Shared leases is not on the Free plan. Upgrade to unlock it.',
        error: 'Forbidden',
      }),
    );
    const result = await leases.take('src/billing', holder, 30);
    expect(result.outcome).toBe(SHARED_OUTCOME.UNKNOWN);
  });

  it('reads a revoked token the same way, rather than blocking work', async () => {
    const leases = new CloudLeases(await enrolled(), answering(401, {}));
    expect((await leases.take('src/billing', holder, 30)).outcome).toBe(
      SHARED_OUTCOME.UNKNOWN,
    );
  });

  it('reads an unreachable control plane the same way', async () => {
    const failing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;

    const leases = new CloudLeases(await enrolled(), failing);
    expect((await leases.take('src/billing', holder, 30)).outcome).toBe(
      SHARED_OUTCOME.UNKNOWN,
    );
  });
});

/* The write path keeps no ids for what it took, so a session that ended left its
   files held on every other machine until the window ran out. */
describe('a session ending', () => {
  it('asks the workspace to release everything this session holds', async () => {
    const asked: { url: string; body: unknown }[] = [];
    const fetcher = (async (url: string, init: { body: string }) => {
      asked.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ released: 2 }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await new CloudLeases(await enrolled(), fetcher).releaseSession(holder);

    expect(asked).toEqual([
      {
        url: 'https://control.example.com/v1/workspaces/acme/leases/release',
        body: { holder: { agent: 'hermes', session: 'ses_a' } },
      },
    ]);
  });

  it('makes no call from a machine that is not enrolled', async () => {
    let called = false;
    const fetcher = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await new CloudLeases(
      await mkdtemp(join(tmpdir(), 'memnox-shared-')),
      fetcher,
    ).releaseSession(holder);

    expect(called).toBe(false);
  });
});
