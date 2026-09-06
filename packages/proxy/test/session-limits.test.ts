import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT, type SessionPause } from '@memnox/core';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import {
  McpFirewall,
  SessionLimitedAuthorizer,
  UngovernedAuthorizer,
  type CallAuthorizer,
  type CallVerdict,
  type SessionLimits,
  type ToolCall,
} from '../src/index';

const SESSION = 'sess-1';

const call = (name: string): ToolCall => ({ name, arguments: {} });

const PAUSE: SessionPause = {
  sessionId: SESSION,
  signal: 'error-loop',
  reason: 'the same call failed 5 times',
  reached: 5,
  ceiling: 5,
  pausedAt: '2026-01-01T00:00:00.000Z',
};

class CountingAuthorizer implements CallAuthorizer {
  asked = 0;
  async authorize(): Promise<CallVerdict> {
    this.asked += 1;
    return { effect: DECISION_EFFECT.ALLOW, reason: 'permitted by policy' };
  }
}

function limits(over: Partial<SessionLimits> = {}): SessionLimits {
  return {
    heldBy: async () => null,
    exhausted: async () => null,
    observe: async () => null,
    ...over,
  };
}

/** The child reduced to what the proxy touches; see `firewall-lifecycle.test.ts`. */
function fakeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    stdin: { writable: true, write: () => true, end: () => undefined },
    stdout: new EventEmitter(),
  }) as unknown as ChildProcess;
}

/** One tool call, in and back out, so the record hook runs the way it does live. */
async function callThrough(firewall: McpFirewall, tool: string): Promise<void> {
  const child = fakeChild();
  const input = new EventEmitter();
  firewall.start({ spawn: () => child, input, exit: () => undefined });

  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: tool, arguments: {} },
  };
  input.emit('data', Buffer.from(`${JSON.stringify(request)}\n`));
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout?.emit(
    'data',
    Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`),
  );
  await new Promise((resolve) => setImmediate(resolve));
}

describe('a paused session reaches no tool', () => {
  it('refuses the call and never asks the rules', async () => {
    /* The gap this closes: `pauseHolding` was read by the shell interceptor and by
       nothing on this path, so an agent the breaker had stopped went on making MCP
       calls. "Memnox paused the agent" was true of the shell and false of the tools. */
    const rules = new CountingAuthorizer();
    const authorizer = new SessionLimitedAuthorizer(
      rules,
      limits({ heldBy: async () => PAUSE }),
      SESSION,
    );

    const verdict = await authorizer.authorize(call('write_file'));

    expect(verdict.effect).toBe(DECISION_EFFECT.DENY);
    expect(verdict.reason).toContain('memnox resume sess-1');
    expect(rules.asked).toBe(0);
  });

  it('holds even where no policy file governs the machine', async () => {
    // A pause is not a statement about rules, so having none must not lift it.
    const authorizer = new SessionLimitedAuthorizer(
      new UngovernedAuthorizer(),
      limits({ heldBy: async () => PAUSE }),
      SESSION,
    );

    expect((await authorizer.authorize(call('write_file'))).effect).toBe(
      DECISION_EFFECT.DENY,
    );
  });
});

describe('a spent budget reaches no tool', () => {
  it('refuses with the allowance message, not a policy one', async () => {
    const authorizer = new SessionLimitedAuthorizer(
      new CountingAuthorizer(),
      limits({ exhausted: async () => 'no allowance left until tomorrow' }),
      SESSION,
    );

    const verdict = await authorizer.authorize(call('deploy'));

    expect(verdict.effect).toBe(DECISION_EFFECT.DENY);
    expect(verdict.reason).toBe('no allowance left until tomorrow');
  });

  it('asks the budget with the same action the rules match on', async () => {
    const asked: string[] = [];
    const authorizer = new SessionLimitedAuthorizer(
      new CountingAuthorizer(),
      limits({
        exhausted: async (action) => {
          asked.push(action);
          return null;
        },
      }),
      SESSION,
    );

    await authorizer.authorize(call('deploy'));

    // One budget has to cover a tool call and the shell command that does the same.
    expect(asked).toEqual(['mcp.deploy']);
  });

  it('reads the pause before the budget', async () => {
    /* A budget message shown to somebody whose agent is looping sends them editing
       allowances instead of looking at the loop. */
    const order: string[] = [];
    const authorizer = new SessionLimitedAuthorizer(
      new CountingAuthorizer(),
      limits({
        heldBy: async () => {
          order.push('pause');
          return PAUSE;
        },
        exhausted: async () => {
          order.push('budget');
          return 'no allowance left';
        },
      }),
      SESSION,
    );

    await authorizer.authorize(call('deploy'));

    expect(order).toEqual(['pause']);
  });
});

describe('a session nobody named', () => {
  it('is not held, and its budget is still counted', async () => {
    const asked: string[] = [];
    const authorizer = new SessionLimitedAuthorizer(
      new CountingAuthorizer(),
      limits({
        heldBy: async () => {
          asked.push('pause');
          return PAUSE;
        },
      }),
      undefined,
    );

    const verdict = await authorizer.authorize(call('read_file'));

    // No session id, so there is no session to have been paused.
    expect(asked).toEqual([]);
    expect(verdict.effect).toBe(DECISION_EFFECT.ALLOW);
  });
});

describe('the firewall actually applies them', () => {
  /* The decorator passing its own unit tests says nothing about whether anything
     builds it — that is the "a projection nobody registered" failure, and it is
     what left this whole path unguarded in the first place. So this asks the
     firewall, not the class. */
  it('asks the pause on a call that goes through the wrapped server', async () => {
    const asked: string[] = [];
    const firewall = new McpFirewall({
      command: ['node', 'server.js'],
      serverName: 'demo',
      sessionId: SESSION,
      log: () => {},
      limits: limits({
        heldBy: async (sessionId) => {
          asked.push(sessionId);
          return null;
        },
      }),
    });

    await callThrough(firewall, 'write_file');

    expect(asked).toEqual([SESSION]);
  });

  it('asks the budget too, on a machine with no policy file at all', async () => {
    const asked: string[] = [];
    const firewall = new McpFirewall({
      command: ['node', 'server.js'],
      serverName: 'demo',
      sessionId: SESSION,
      log: () => {},
      limits: limits({
        exhausted: async (action) => {
          asked.push(action);
          return null;
        },
      }),
    });

    await callThrough(firewall, 'deploy');

    // No `gate`, so the rules are ungoverned — and an allowance still counts.
    expect(asked).toEqual(['mcp.deploy']);
  });
});

describe('the breaker sees what the proxy did', () => {
  it('replays the session after every call, so a loop of tool calls trips it', async () => {
    /* The other half of the same gap, and the quieter one. The proxy already wrote
       its outcomes to the ledger the breaker replays — `observeSession` was simply
       called from nowhere on this path, so an agent that never touched a shell
       could loop until somebody noticed the bill. */
    const observed: string[] = [];
    const firewall = new McpFirewall({
      command: ['node', 'server.js'],
      serverName: 'demo',
      sessionId: SESSION,
      log: () => {},
      limits: limits({
        observe: async (sessionId) => {
          observed.push(sessionId);
          return null;
        },
      }),
    });

    await callThrough(firewall, 'write_file');
    await callThrough(firewall, 'write_file');

    expect(observed).toEqual([SESSION, SESSION]);
  });

  it('replays nothing when no session groups the calls', async () => {
    const observed: string[] = [];
    const firewall = new McpFirewall({
      command: ['node', 'server.js'],
      serverName: 'demo',
      log: () => {},
      limits: limits({
        observe: async (sessionId) => {
          observed.push(sessionId);
          return null;
        },
      }),
    });

    await callThrough(firewall, 'write_file');

    // A pause is per session; without one there is nothing to hold or to replay.
    expect(observed).toEqual([]);
  });
});
