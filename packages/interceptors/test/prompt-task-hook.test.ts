import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionTasks, writePolicyDocumentFile } from '@memnox/core';
import { beforePause } from '../src/in-session';
import { loadHookGate } from '../src/hook-gate-loader';
import { SESSION_MOMENT } from '../src/session-events';

describe('an ask typed into a hooked session', () => {
  it('becomes the session task, and an investigation refuses a change outside the machine', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-prompt-'));
    const rules = join(home, 'rules.toml');
    await mkdir(home, { recursive: true });
    await writePolicyDocumentFile(rules, { version: 1, policies: [] });
    const context = {
      home,
      agent: 'claude-code',
      runSession: undefined,
      pid: 1,
      cwd: home,
      now: () => new Date('2026-09-26T10:00:00.000Z'),
    };
    const said = await beforePause(
      {},
      {
        moment: SESSION_MOMENT.PROMPT,
        sessionId: 'host-1',
        prompt: 'investigate why the payments failed',
      } as never,
      context as never,
      {},
    );
    expect(said).toContain('investigation');
    expect((await new SessionTasks(home).read('host-1'))?.statement).toBe(
      'investigate why the payments failed',
    );

    const gate = await loadHookGate(
      {
        policyFiles: [rules],
        fromRegistry: false,
        agentName: 'claude-code',
        hostSessionId: 'host-1',
      },
      home,
    );
    const refund = gate?.evaluate({
      action: 'mcp.stripe.create_refund',
      toolClass: 'write',
    });
    expect(refund?.effect).toBe('deny');
    expect(
      gate?.evaluate({ action: 'mcp.stripe.list_charges', toolClass: 'read' }).effect,
    ).toBe('allow');
  });
});
