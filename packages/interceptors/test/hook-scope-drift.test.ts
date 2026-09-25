import { describe, expect, it } from 'vitest';
import { ENFORCEMENT_MODE, LocalGate } from '@memnox/core';
import { HookAuthorizer } from '../src/hook-authorizer';
import { ruleOnTool } from '../src/tool-policy';
import { toolCallOf } from '../src/tool-calls';

const TASK = {
  id: 'tsk_1',
  sessionId: 'repo:/w/app',
  statement: 'fix the retry in payments',
  scope: { paths: ['/w/app/src/payments/**'] },
  declaredAt: '2026-09-26T10:00:00.000Z',
};

function edit(path: string): Record<string, unknown> {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    cwd: '/w/app',
    tool_name: 'Write',
    tool_use_id: 't1',
    tool_input: { file_path: path, content: 'x' },
  };
}

async function ruled(path: string): Promise<boolean | undefined> {
  const call = toolCallOf(edit(path), '/home/dev');
  if (call === null) throw new Error('no call');
  const gate = new LocalGate([], { agentName: 'claude-code', task: TASK } as never);
  const ruling = await ruleOnTool(call, {
    authorizer: new HookAuthorizer({ gate }),
    mode: ENFORCEMENT_MODE.ENFORCE,
    env: {},
  });
  return ruling.outOfScope;
}

describe('a hooked edit against the declared task', () => {
  it('is marked outside it, which is what the breaker is told', async () => {
    expect(await ruled('/w/app/src/infra/main.tf')).toBe(true);
  });

  it('is not, inside it', async () => {
    expect(await ruled('/w/app/src/payments/retry.ts')).toBeUndefined();
  });
});
