import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '@memnox/core';
import { CONTROL_OUTCOME, acknowledgeControl, drainControl } from '../src/sync/control';

/**
 * Collecting what an operator said, on this machine's own move.
 *
 * The seam still runs one way: nothing dials a laptop, it asks. What arrives is
 * a person's words and never a verdict, so nothing here reads a message as
 * permission to do anything.
 */

const BASE = 'https://cloud.memnox.test';

const account: Account = {
  version: 1,
  baseUrl: BASE,
  workspaceId: 'acme',
  machineId: 'mch_1',
  token: 'machine-token',
  privateKey: 'unused-here',
  enrolledAt: '2026-09-05T10:00:00.000Z',
};

interface Call {
  url: string;
  body: unknown;
  authorization?: string;
}

describe('collecting what an operator said', () => {
  let calls: Call[];
  let answer: { status: number; body: unknown };

  beforeEach(() => {
    calls = [];
    answer = { status: 200, body: { commands: [] } };
    vi.stubGlobal('fetch', (async (url: URL | string, init?: RequestInit) => {
      const headers = (init === undefined ? {} : init.headers) as
        Record<string, string> | undefined;
      calls.push({
        url: String(url),
        body: init === undefined ? undefined : JSON.parse(String(init.body)),
        ...(headers === undefined ? {} : { authorization: headers['authorization'] }),
      });
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks the control plane rather than waiting to be told', async () => {
    await drainControl(account, 'claude-code');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `${BASE}/v1/workspaces/acme/agents/claude-code/control/drain`,
    );
  });

  it('carries the credential belonging to this machine and nothing else', async () => {
    await drainControl(account, 'claude-code');

    expect(calls[0]?.authorization).toBe('Bearer machine-token');
  });

  it('hands back what was said', async () => {
    answer = {
      status: 200,
      body: {
        commands: [
          {
            id: 'c1',
            agentId: 'claude-code',
            message: 'stop the deploy',
            issuedBy: 'ada',
            issuedAt: '2026-01-01T10:00:00.000Z',
            status: 'delivered',
          },
        ],
      },
    };

    const result = await drainControl(account, 'claude-code');

    expect(result.outcome).toBe(CONTROL_OUTCOME.COLLECTED);
    expect(result.commands[0]?.message).toBe('stop the deploy');
  });

  it('reads an empty channel as nothing rather than as a failure', async () => {
    const result = await drainControl(account, 'claude-code');

    expect(result.outcome).toBe(CONTROL_OUTCOME.NOTHING);
    expect(result.commands).toEqual([]);
  });

  it('names a revoked credential as revoked, so login can be offered', async () => {
    answer = { status: 403, body: {} };

    const result = await drainControl(account, 'claude-code');

    expect(result.outcome).toBe(CONTROL_OUTCOME.REVOKED);
  });

  it('treats an unreachable control plane as nothing said', async () => {
    /* A machine that cannot reach its control plane has had nothing said to it,
       which is the same as nothing being said. Reporting it as a refusal would
       put a warning in front of somebody whose network is merely down. */
    vi.stubGlobal('fetch', (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as typeof fetch);

    const result = await drainControl(account, 'claude-code');

    expect(result.outcome).toBe(CONTROL_OUTCOME.NOTHING);
  });

  it('escapes an agent name so it cannot reach a path of its own', async () => {
    await drainControl(account, 'evil/../../other');

    expect(calls[0]?.url).toContain('evil%2F..%2F..%2Fother');
  });
});

describe('saying what became of a turn', () => {
  let calls: Call[];
  let status: number;

  beforeEach(() => {
    calls = [];
    status = 200;
    vi.stubGlobal('fetch', (async (url: URL | string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: init === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return new Response('{}', {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('acknowledges against the turn it answers', async () => {
    await acknowledgeControl(account, 'claude-code', 'c1', { ok: true });

    expect(calls[0]?.url).toBe(
      `${BASE}/v1/workspaces/acme/agents/claude-code/control/commands/c1/ack`,
    );
    expect(calls[0]?.body).toEqual({ ok: true });
  });

  it('carries the reason when there is one', async () => {
    await acknowledgeControl(account, 'claude-code', 'c1', {
      ok: false,
      error: 'no session to interrupt',
    });

    expect(calls[0]?.body).toEqual({
      ok: false,
      error: 'no session to interrupt',
    });
  });

  it('does not fail the message because the receipt did not land', async () => {
    /* The turn has already been delivered and whoever was at the agent has
       already seen it. Losing the thing that worked over the thing that did not
       is the wrong trade. */
    vi.stubGlobal('fetch', (async () => {
      throw new Error('ECONNRESET');
    }) as typeof fetch);

    await expect(
      acknowledgeControl(account, 'claude-code', 'c1', { ok: true }),
    ).resolves.toBe(false);
  });
});
