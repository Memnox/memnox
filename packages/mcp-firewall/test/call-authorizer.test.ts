import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT, RISK_LEVEL } from '@memnox/core';
import { MemnoxClient, type HttpTransport } from '@memnox/sdk';
import { isAllowed, RuntimeAuthorizer } from '../src/index';

interface Call {
  action: string;
  target?: string;
  sessionId?: string;
  arguments?: Record<string, string>;
  signals?: string[];
}

const call = (name: string, args: Record<string, string> = {}) => ({
  name,
  arguments: args,
});

const calls: Call[] = [];

function respondWith(decision: Record<string, unknown>): HttpTransport {
  return async (_url, init) => {
    calls.push(JSON.parse(init.body ?? '{}') as Call);
    return new Response(JSON.stringify(decision), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

const unreachable: HttpTransport = async () => {
  throw new Error('ECONNREFUSED');
};

function authorizer(
  transport: HttpTransport,
  over: { failOpen?: boolean; sessionId?: string } = {},
): { subject: RuntimeAuthorizer; logs: string[] } {
  const logs: string[] = [];
  const subject = new RuntimeAuthorizer(
    new MemnoxClient({
      baseUrl: 'http://runtime.test',
      token: 'mnx_1',
      fetch: transport,
    }),
    {
      serverName: 'github',
      failOpen: over.failOpen,
      sessionId: over.sessionId,
      log: (message) => logs.push(message),
    },
  );
  return { subject, logs };
}

const allowed = {
  effect: DECISION_EFFECT.ALLOW,
  riskLevel: RISK_LEVEL.LOW,
  reason: 'read-only tool',
  matchedPolicies: [],
};

describe('RuntimeAuthorizer', () => {
  it('allows a call the runtime allows, carrying the policy reason through', async () => {
    const { subject } = authorizer(respondWith(allowed));

    expect(await subject.authorize(call('read_file'))).toEqual({
      effect: DECISION_EFFECT.ALLOW,
      reason: 'read-only tool',
    });
  });

  it('namespaces the tool under mcp.* and targets the wrapped server', async () => {
    calls.length = 0;
    const { subject } = authorizer(respondWith(allowed), { sessionId: 'sess-9' });

    await subject.authorize(call('create_issue'));

    expect(calls[0]).toMatchObject({
      action: 'mcp.create_issue',
      target: 'github',
      sessionId: 'sess-9',
    });
  });

  it('blocks a call the runtime blocks', async () => {
    const { subject } = authorizer(
      respondWith({ ...allowed, effect: DECISION_EFFECT.BLOCK, reason: 'destructive' }),
    );

    const verdict = await subject.authorize(call('delete_repo'));

    expect(isAllowed(verdict)).toBe(false);
    expect(verdict.reason).toContain('destructive');
  });

  it('tells the caller how to resolve a pending approval', async () => {
    const { subject } = authorizer(
      respondWith({
        ...allowed,
        effect: DECISION_EFFECT.REQUIRE_APPROVAL,
        reason: 'needs sign-off',
        approvalId: 'apr_7',
      }),
    );

    const verdict = await subject.authorize(call('merge_pr'));

    expect(isAllowed(verdict)).toBe(false);
    expect(verdict.reason).toContain('memnox approvals resolve apr_7');
  });

  it('fails closed when the runtime is unreachable', async () => {
    const { subject, logs } = authorizer(unreachable);

    const verdict = await subject.authorize(call('read_file'));

    expect(isAllowed(verdict)).toBe(false);
    expect(verdict.reason).toContain('failing closed');
    expect(logs).toEqual([]);
  });

  it('fails open only when explicitly configured, and says so in the log', async () => {
    const { subject, logs } = authorizer(unreachable, { failOpen: true });

    const verdict = await subject.authorize(call('read_file'));

    expect(isAllowed(verdict)).toBe(true);
    expect(verdict.reason).toContain('fail-open');
    expect(logs[0]).toContain('runtime unreachable, failing open');
  });
});
