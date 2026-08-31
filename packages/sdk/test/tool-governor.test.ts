import { describe, expect, it, vi } from 'vitest';
import {
  DECISION_EFFECT,
  ENFORCEMENT_MODE,
  RISK_LEVEL,
  type Decision,
} from '@memnox/core';
import type { MemnoxClient } from '../src/client';
import {
  governTool,
  governTools,
  ToolRefusedError,
  type ToolRefusal,
} from '../src/tool-governor';

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    eventId: 'evt-1',
    effect: DECISION_EFFECT.ALLOW,
    riskLevel: RISK_LEVEL.LOW,
    reason: 'no policy matched',
    matchedPolicies: [],
    advisories: [],
    mode: ENFORCEMENT_MODE.ENFORCE,
    evaluatedAt: '2026-01-01T00:00:00.000Z',
    latencyUs: 120,
    ...overrides,
  };
}

/** Only `check` matters here — the rest of the client is irrelevant to governing. */
function clientReturning(next: Decision): {
  client: MemnoxClient;
  checked: Array<Record<string, unknown>>;
} {
  const checked: Array<Record<string, unknown>> = [];
  const client = {
    check: async (request: Record<string, unknown>) => {
      checked.push(request);
      return next;
    },
  } as unknown as MemnoxClient;
  return { client, checked };
}

describe('governTool', () => {
  it('runs the tool when the runtime allows it', async () => {
    const { client } = clientReturning(decision());
    const handler = vi.fn(async (args: { path: string }) => `read ${args.path}`);

    const governed = governTool(client, { name: 'readFile', handler });
    await expect(governed({ path: 'src/a.ts' })).resolves.toBe('read src/a.ts');
    expect(handler).toHaveBeenCalledOnce();
  });

  it('never runs the tool when the runtime withholds it', async () => {
    const { client } = clientReturning(
      decision({ effect: DECISION_EFFECT.WITHHOLD, reason: 'production is off limits' }),
    );
    const handler = vi.fn(async () => 'should not run');

    const governed = governTool(client, { name: 'dropTable', handler });
    await expect(governed({})).rejects.toThrow(ToolRefusedError);
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses on require_approval too, carrying the approval id', async () => {
    const { client } = clientReturning(
      decision({
        effect: DECISION_EFFECT.ESCALATE,
        reason: 'needs security review',
        approvalId: 'apr-1',
      }),
    );
    const governed = governTool(client, { name: 'deploy', handler: async () => 'ok' });

    await expect(governed({})).rejects.toMatchObject({
      refusal: { approvalId: 'apr-1', effect: DECISION_EFFECT.ESCALATE },
    });
  });

  it('hands the refusal back as a value when onRefused is supplied', async () => {
    const { client } = clientReturning(
      decision({ effect: DECISION_EFFECT.WITHHOLD, reason: 'withheld' }),
    );
    const seen: ToolRefusal[] = [];
    const governed = governTool(
      client,
      { name: 'dropTable', handler: async () => 'never' },
      {
        onRefused: ((refusal: ToolRefusal) => {
          seen.push(refusal);
          return 'refused' as never;
        }) as never,
      },
    );

    await expect(governed({})).resolves.toBe('refused');
    expect(seen[0]?.toolName).toBe('dropTable');
  });

  it('names the action after the tool and picks a readable target', async () => {
    const { client, checked } = clientReturning(decision());
    await governTool(client, { name: 'WriteFile', handler: async () => 'ok' })({
      file_path: 'src/payment/checkout.ts',
    });

    expect(checked[0]).toMatchObject({
      action: 'tool.writefile',
      target: 'src/payment/checkout.ts',
    });
  });

  it('carries session and environment onto every check', async () => {
    const { client, checked } = clientReturning(decision());
    await governTool(
      client,
      { name: 'deploy', handler: async () => 'ok' },
      { sessionId: 'run-1', environment: 'production' },
    )({});

    expect(checked[0]).toMatchObject({
      sessionId: 'run-1',
      environment: 'production',
    });
  });

  it('accepts a custom action mapping', async () => {
    const { client, checked } = clientReturning(decision());
    await governTool(
      client,
      { name: 'sql', handler: async () => 'ok' },
      {
        mapAction: (_name, args: { table: string }) => ({
          action: 'database.delete',
          target: args.table,
        }),
      },
    )({ table: 'users' });

    expect(checked[0]).toMatchObject({ action: 'database.delete', target: 'users' });
  });
});

describe('governTools', () => {
  it('wraps a whole registry and preserves the tool names', async () => {
    const { client, checked } = clientReturning(decision());
    const governed = governTools(client, {
      readFile: async () => 'read',
      writeFile: async () => 'wrote',
    });

    expect(Object.keys(governed)).toEqual(['readFile', 'writeFile']);
    await governed['writeFile']?.({});
    expect(checked[0]).toMatchObject({ action: 'tool.writefile' });
  });
});
