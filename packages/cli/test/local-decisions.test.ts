import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeAccount, type Account } from '@memnox/core';
import {
  decisionRef,
  localDecisionEvents,
  readLocalDecisions,
  recordLocalDecisions,
} from '../src/sync/local-decisions';
import { pushDecisions, PUSH_OUTCOME } from '../src/sync/push';
import { CLOUD_EVENT } from '../src/sync/cloud-event';

/**
 * A rule a person decides on an enrolled machine is offered to the team: kept here,
 * sent once on the next sync, and turned into a proposal on the other side. Who decided
 * is never in what is sent, because the control plane names the machine's owner.
 */

const PRIVATE_KEY = generateKeyPairSync('ed25519')
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

const ACCOUNT: Account = {
  version: 1,
  baseUrl: 'https://cloud.test',
  workspaceId: 'acme',
  machineId: 'mch_1',
  token: 'machine-token',
  privateKey: PRIVATE_KEY,
  enrolledAt: '2026-09-24T09:00:00.000Z',
};

const DECIDED = {
  operation: 'git.push',
  effect: 'deny' as const,
  decidedAt: '2026-09-24T09:30:00.000Z',
};

describe('a rule decided on this machine', () => {
  let home: string;
  let posted: { events: { kind: string; payload: Record<string, unknown> }[] }[];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'memnox-decisions-'));
    posted = [];
    vi.stubGlobal('fetch', (async (_url: string | URL, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(JSON.stringify({ accepted: 1, duplicates: 0 }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(home, { recursive: true, force: true });
  });

  it('is not kept on a machine with no team to offer it to', async () => {
    expect(await recordLocalDecisions(home, [DECIDED])).toBe(0);
    expect(await readLocalDecisions(home)).toEqual([]);
  });

  it('is kept once however many times it is written', async () => {
    await writeAccount(home, ACCOUNT);

    expect(await recordLocalDecisions(home, [DECIDED])).toBe(1);
    expect(await recordLocalDecisions(home, [DECIDED])).toBe(0);
    expect(await readLocalDecisions(home)).toEqual([
      { ...DECIDED, ref: decisionRef('deny', 'git.push') },
    ]);
  });

  it('is sent once, as an event that names no decider', async () => {
    await writeAccount(home, ACCOUNT);
    await recordLocalDecisions(home, [DECIDED]);

    expect((await pushDecisions(home, ACCOUNT)).outcome).toBe(PUSH_OUTCOME.SENT);
    expect((await pushDecisions(home, ACCOUNT)).outcome).toBe(PUSH_OUTCOME.NOTHING);

    expect(posted).toHaveLength(1);
    const [event] = posted[0]?.events ?? [];
    expect(event?.kind).toBe(CLOUD_EVENT.RULE_DECIDED_LOCALLY);
    expect(event?.payload).toEqual({
      ref: decisionRef('deny', 'git.push'),
      operation: 'git.push',
      effect: 'deny',
    });
  });

  it('carries the agent it was narrowed to, where it was', () => {
    const [event] = localDecisionEvents([
      { ...DECIDED, effect: 'allow', agent: 'hermes', ref: 'dec_1' },
    ]);

    expect(event?.payload['agent']).toBe('hermes');
    expect(event?.dedupKey).toBe(`${CLOUD_EVENT.RULE_DECIDED_LOCALLY}:dec_1`);
  });
});
