import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DECISION_EFFECT,
  ENFORCEMENT_MODE,
  FileGrants,
  LocalGate,
  type Policy,
} from '@memnox/core';
import { HookAuthorizer } from '../src/hook-authorizer';
import { learnFromAnswer, rememberQuestion } from '../src/prompt-answers';
import { answerToolCall } from '../src/tool-hook';

/**
 * Somebody allowing the same read three times in one session, which is what
 * `gh.pr-view allowed for this session` printed three times in a row looked like.
 */

const NOW = new Date('2026-09-25T10:00:00.000Z');

const RULES: Policy[] = [
  {
    name: 'cli-ask',
    match: { actions: ['gh.*', 'railway.*'] },
    decision: { effect: DECISION_EFFECT.ASK, reason: 'a person looks at the CLIs' },
  } as never,
];

function bash(event: string, id: string, command: string): Record<string, unknown> {
  return {
    hook_event_name: event,
    session_id: 's1',
    cwd: '/work/repo',
    permission_mode: 'default',
    tool_name: 'Bash',
    tool_use_id: id,
    tool_input: { command },
  };
}

async function machine(): Promise<{
  home: string;
  deps: Parameters<typeof learnFromAnswer>[1];
}> {
  const home = await mkdtemp(join(tmpdir(), 'memnox-grant-hook-'));
  return {
    home,
    deps: {
      home,
      agent: 'claude-code',
      runSession: undefined,
      env: {},
      now: () => NOW,
      sink: null,
      mode: ENFORCEMENT_MODE.ENFORCE,
      authorizer: new HookAuthorizer({
        gate: new LocalGate(RULES, { agentName: 'agent' }),
      }),
    },
  };
}

/** One call, start to finish: ruled on, asked, and run because the person said yes. */
async function allowedInPrompt(
  deps: Parameters<typeof learnFromAnswer>[1],
  id: string,
  command: string,
): Promise<string> {
  const before = bash('PreToolUse', id, command);
  const answer = await answerToolCall(
    before,
    { ...deps, personThere: true },
    { authorizer: deps.authorizer!, mode: ENFORCEMENT_MODE.ENFORCE, sink: null },
  );
  if (answer === null) throw new Error('no answer');
  if (answer.asked) {
    await rememberQuestion(before, answer, deps);
    await learnFromAnswer(bash('PostToolUse', id, command), deps);
  }
  return answer.ruling.effect;
}

describe('the same yes in the same session', () => {
  it('is asked twice and then let through', async () => {
    const { deps } = await machine();
    expect(await allowedInPrompt(deps, 't1', 'gh pr view 12')).toBe(DECISION_EFFECT.ASK);
    expect(await allowedInPrompt(deps, 't2', 'gh pr view 13')).toBe(DECISION_EFFECT.ASK);
    expect(await allowedInPrompt(deps, 't3', 'gh pr view 14')).toBe(
      DECISION_EFFECT.ALLOW,
    );
  });

  it('is not carried to another action', async () => {
    const { deps } = await machine();
    await allowedInPrompt(deps, 't1', 'gh pr view 12');
    await allowedInPrompt(deps, 't2', 'gh pr view 13');
    expect(await allowedInPrompt(deps, 't3', 'gh pr merge 12')).toBe(DECISION_EFFECT.ASK);
  });

  it('is let through at once after "for this session" from the workspace', async () => {
    const { home, deps } = await machine();
    await new FileGrants(home).grant({
      sessionId: 's1',
      operation: 'gh.pr-view',
      fingerprint: 'x',
      class: 'read',
    });
    expect(await allowedInPrompt(deps, 't1', 'gh pr view 12')).toBe(
      DECISION_EFFECT.ALLOW,
    );
  });

  it('never lets a delete through on a count', async () => {
    const { deps } = await machine();
    for (const id of ['t1', 't2']) await allowedInPrompt(deps, id, 'railway down');
    expect(await allowedInPrompt(deps, 't3', 'railway down')).toBe(DECISION_EFFECT.ASK);
  });
});
