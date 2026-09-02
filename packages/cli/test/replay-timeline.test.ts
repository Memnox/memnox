import { describe, expect, it } from 'vitest';
import type { ActionEvent } from '@memnox/core';
import { registerReplayCommand } from '../src/commands/replay.command';
import { FakeRuntime, runCommand } from './cli-harness';

const SESSION = 'ses_4f2a';

function event(overrides: Partial<ActionEvent>): ActionEvent {
  return {
    id: 'evt_1',
    occurredAt: '2026-08-31T10:04:00.000Z',
    agentId: 'agt_1',
    agentName: 'claude-code',
    action: 'repository.read',
    sessionId: SESSION,
    effect: 'allow',
    riskLevel: 'low',
    matchedPolicies: [],
    advisories: [],
    reason: 'no rule matched',
    ...overrides,
  } as ActionEvent;
}

function frame(at: string, kind: string, summary: string) {
  return { id: `frm_${at}`, sessionId: SESSION, agentId: 'agt_1', at, kind, summary };
}

async function replay(events: ActionEvent[], frames: unknown[] | null) {
  const runtime = new FakeRuntime()
    .handle('GET', '/v1/audit', () => ({ body: events }))
    .handle('GET', `/v1/sessions/${SESSION}/lineage`, () => ({
      body: { lineage: { hops: [] } },
    }));
  if (frames === null) {
    runtime.handle('GET', `/v1/sessions/${SESSION}/frames`, () => ({
      status: 503,
      body: { error: 'this runtime keeps no frames' },
    }));
  } else {
    runtime.handle('GET', `/v1/sessions/${SESSION}/frames`, () => ({ body: frames }));
  }
  return runCommand(registerReplayCommand, ['replay', SESSION], runtime);
}

describe('memnox replay — the observed timeline', () => {
  /**
   * A factual history instead of a summary: every row is something a seam saw, not
   * something the thing being asked about wrote.
   */
  it('prints what the seams observed, in order', async () => {
    const { out } = await replay(
      [event({})],
      [
        frame('2026-08-31T10:04:00.000Z', 'file', 'read src/auth.ts'),
        frame('2026-08-31T10:11:00.000Z', 'file', 'write src/auth.ts'),
        frame('2026-08-31T10:18:00.000Z', 'shell', 'npm test'),
      ],
    );

    expect(out.text).toContain('OBSERVED AT THE SEAMS');
    expect(out.text).toContain('10:04');
    expect(out.text).toContain('read src/auth.ts');
    expect(out.text).toContain('npm test');
    expect(out.text.indexOf('read src/auth.ts')).toBeLessThan(
      out.text.indexOf('npm test'),
    );
  });

  /** A runtime that keeps no frames serves none. That is a gap, not a crash. */
  it('still replays the decisions when the runtime keeps no frames', async () => {
    const { out } = await replay([event({})], null);

    expect(out.text).toContain('repository.read');
    expect(out.text).not.toContain('OBSERVED AT THE SEAMS');
  });

  it('says nothing about seams when the session has no frames', async () => {
    const { out } = await replay([event({})], []);

    expect(out.text).not.toContain('OBSERVED AT THE SEAMS');
  });
});

describe('memnox replay — the claim against the record', () => {
  /**
   * "Deployment completed successfully" is generated text. Where the agent's report
   * disagrees with what was intercepted, the seam wins.
   */
  it('names an action the agent claimed succeeded but was never allowed', async () => {
    const { out } = await replay(
      [
        event({ id: 'e1', action: 'deploy.service', effect: 'withhold' }),
        event({
          id: 'e2',
          action: 'deploy.service',
          effect: 'allow',
          defiedVerdict: true,
        } as Partial<ActionEvent>),
      ],
      [],
    );

    expect(out.text).toContain('THE CLAIM AGAINST THE RECORD');
    expect(out.text).toContain('1 action(s) withheld');
    expect(out.text).toContain('claimed success on deploy.service');
  });

  it('counts an execution that failed at any stage', async () => {
    const { out } = await replay(
      [event({ executionStatus: 'postcondition_failed' } as Partial<ActionEvent>)],
      [],
    );

    expect(out.text).toContain('1 action(s) reported as failed');
  });

  /** A clean session gets no section: the heading exists to mean something. */
  it('stays quiet when nothing disagrees', async () => {
    const { out } = await replay([event({})], []);

    expect(out.text).not.toContain('THE CLAIM AGAINST THE RECORD');
  });
});
