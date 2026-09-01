import { DECISION_EFFECT, type ActionRequest, type Decision } from '@memnox/core';
import { LocalGate } from '@memnox/local-gate';
import type { MemnoxClient } from '@memnox/sdk';
import { describe, expect, it } from 'vitest';
import { HookAuthorizer, HookAuthorizer as RealAuthorizer } from '../src/hook-authorizer';

const read: ActionRequest = {
  action: 'filesystem.read',
  target: '/srv/app/.env',
  arguments: { file_path: '/srv/app/.env' },
};

/** Typed by inference: the shape is the policy file a person would write. */
const withholdEnv = {
  name: 'secrets-not-required',
  match: { actions: ['filesystem.read'], targets: ['*.env'] },
  decision: {
    effect: DECISION_EFFECT.WITHHOLD,
    reason: 'no credential need was declared',
    alternative: {
      action: 'filesystem.read',
      resource: '.env.example',
      note: 'readable',
    },
  },
};

const gate = (): LocalGate => new LocalGate([withholdEnv], { agentName: 'claude-code' });

/** Records what was asked, so the arguments never leaving the machine is testable. */
class RecordingClient {
  readonly seen: ActionRequest[] = [];
  readonly reported: unknown[] = [];
  async reportDecision(report: unknown): Promise<void> {
    this.reported.push(report);
  }
  constructor(private readonly decision: Partial<Decision>) {}
  async check(request: ActionRequest): Promise<Decision> {
    this.seen.push(request);
    return {
      eventId: 'evt_1',
      effect: DECISION_EFFECT.ALLOW,
      riskLevel: 'low',
      reason: 'allowed',
      matchedPolicies: [],
      advisories: [],
      mode: 'enforce',
      evaluatedAt: '2026-01-01T00:00:00.000Z',
      latencyUs: 1,
      ...this.decision,
    } as Decision;
  }
}

class UnreachableClient {
  async check(): Promise<Decision> {
    throw new Error('connect ECONNREFUSED');
  }
}

function authorizer(deps: {
  gate?: LocalGate;
  client?: unknown;
  failOpen?: boolean;
}): HookAuthorizer {
  return new HookAuthorizer({
    ...(deps.gate === undefined ? {} : { gate: deps.gate }),
    ...(deps.client === undefined ? {} : { client: deps.client as MemnoxClient }),
    ...(deps.failOpen === undefined ? {} : { failOpen: deps.failOpen }),
    log: () => {},
  });
}

describe('HookAuthorizer', () => {
  it('carries the local rule’s alternative, so offline is not a dead end', async () => {
    const verdict = await authorizer({ gate: gate() }).authorize(read);
    expect(verdict.effect).toBe(DECISION_EFFECT.WITHHOLD);
    expect(verdict.alternative?.resource).toBe('.env.example');
  });

  it('never asks the runtime about a call the local gate already refused', async () => {
    const client = new RecordingClient({});
    await authorizer({ gate: gate(), client }).authorize(read);
    expect(client.seen).toEqual([]);
  });

  it('takes the stricter of the two verdicts', async () => {
    const client = new RecordingClient({
      effect: DECISION_EFFECT.WITHHOLD,
      reason: 'production is frozen',
    });
    const verdict = await authorizer({ gate: gate(), client }).authorize({
      action: 'file.write',
      target: 'src/index.ts',
    });
    expect(verdict.effect).toBe(DECISION_EFFECT.WITHHOLD);
    expect(verdict.reason).toBe('production is frozen');
  });

  it('withholds when the runtime cannot be reached', async () => {
    const verdict = await authorizer({ client: new UnreachableClient() }).authorize(read);
    expect(verdict.effect).toBe(DECISION_EFFECT.WITHHOLD);
    expect(verdict.reason).toContain('failing closed');
  });

  it('forwards on an unreachable runtime only when told to, and says so', async () => {
    const verdict = await authorizer({
      client: new UnreachableClient(),
      failOpen: true,
    }).authorize(read);
    expect(verdict.effect).toBe(DECISION_EFFECT.ALLOW);
    expect(verdict.reason).toContain('fail-open');
  });

  it('allows when nothing is configured, and names that as the reason', async () => {
    const verdict = await authorizer({}).authorize(read);
    expect(verdict.effect).toBe(DECISION_EFFECT.ALLOW);
    expect(verdict.reason).toBe('no runtime configured');
  });

  it('carries the approval id so the terminal can answer the escalation', async () => {
    const client = new RecordingClient({
      effect: DECISION_EFFECT.ESCALATE,
      reason: 'a person decides this',
      approvalId: 'apr_7',
    });
    const verdict = await authorizer({ client }).authorize(read);
    expect(verdict.approvalId).toBe('apr_7');
    expect(verdict.decisionId).toBe('evt_1');
  });
});

const AWS_KEY = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');

describe('egress, before anything leaves this machine', () => {
  it('withholds a credential bound for a host no rule forbids', async () => {
    const verdict = await authorizer({}).authorize({
      action: 'http.request',
      target: 'https://api.partner.example/ingest',
      arguments: { body: `key=${AWS_KEY}` },
    });

    expect(verdict.effect).toBe(DECISION_EFFECT.WITHHOLD);
    expect(verdict.reason).toContain('body');
    // Never silently strip: the refusal names the field, never the value.
    expect(verdict.reason).not.toContain(AWS_KEY);
  });

  it('names what to do instead, so the refusal is not a dead end', async () => {
    const verdict = await authorizer({}).authorize({
      action: 'http.request',
      target: 'https://example.com',
      arguments: { password: 'hunter2' },
    });
    expect(verdict.alternative?.note).toContain('without that field');
  });

  it('never asks the runtime about a payload it already refused', async () => {
    const client = new RecordingClient({});
    await authorizer({ client }).authorize({
      action: 'http.request',
      target: 'https://example.com',
      arguments: { token: 'abc' },
    });
    expect(client.seen).toEqual([]);
  });

  it('leaves an ordinary request alone', async () => {
    const verdict = await authorizer({}).authorize({
      action: 'http.request',
      target: 'https://example.com',
      arguments: { body: 'hello' },
    });
    expect(verdict.effect).toBe(DECISION_EFFECT.ALLOW);
  });
});

describe('a local refusal still reaches the ledger', () => {
  /** Reported after the refusal, never before: the payload stays on this machine. */
  it('reports the verdict, carrying the rule and never the arguments', async () => {
    const reported: Record<string, unknown>[] = [];
    const client = {
      check: async () => {
        throw new Error('never reached');
      },
      reportDecision: async (r: Record<string, unknown>) => {
        reported.push(r);
      },
    };

    const verdict = await new RealAuthorizer({
      gate: gate(),
      client: client as never,
      log: () => {},
    }).authorize({
      action: 'filesystem.read',
      target: '/srv/app/.env',
      arguments: { file_path: '/srv/app/.env', body: 'SECRET=x' },
      sessionId: 'ses_1',
    });

    expect(verdict.effect).toBe(DECISION_EFFECT.WITHHOLD);
    await new Promise((r) => setTimeout(r, 0));
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({
      action: 'filesystem.read',
      target: '/srv/app/.env',
      effect: DECISION_EFFECT.WITHHOLD,
      rule: 'secrets-not-required',
      seam: 'hook',
    });
    // The payload that produced it never travels.
    expect(JSON.stringify(reported[0])).not.toContain('SECRET=x');
  });

  it('reports nothing when there is no runtime to report to', async () => {
    const verdict = await new RealAuthorizer({ gate: gate(), log: () => {} }).authorize({
      action: 'filesystem.read',
      target: '/srv/app/.env',
    });
    expect(verdict.effect).toBe(DECISION_EFFECT.WITHHOLD);
  });
});
