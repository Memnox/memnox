import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_ROUTE,
  configPathFor,
  DECISION_EFFECT,
  ENFORCEMENT_MODE,
  LocalGate,
  PendingApprovals,
  type ApprovalRoute,
} from '@memnox/core';
import { HookAuthorizer } from '../src/hook-authorizer';
import { answerInChat } from '../src/in-session';
import { answerToolCall, readApprovalRoute } from '../src/tool-hook';

/* An agent that could not show its own prompt had every ask refused outright, with a note
   that a yes in the conversation could not help. Now the question is held, the person's
   next prompt answers it, and the retry runs, or it goes to their DM when they asked for that. */

const NOW = new Date('2026-09-26T10:00:00.000Z');

const ASK_MERGES = [
  {
    name: 'merges-ask',
    match: { actions: ['gh.*'], classes: ['write'] },
    decision: { effect: 'ask', reason: 'a person looks at merges' },
  },
];

function merge(sessionId = 's1'): Record<string, unknown> {
  return {
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    cwd: '/repo',
    permission_mode: 'default',
    tool_name: 'Bash',
    tool_input: { command: 'gh pr merge 12' },
  };
}

async function ask(home: string, route: ApprovalRoute, personThere = false) {
  const gate = new LocalGate(ASK_MERGES as never, { agentName: 'claude-code' });
  return answerToolCall(
    merge(),
    {
      home,
      agent: 'claude-code',
      runSession: undefined,
      env: {},
      personThere,
      now: () => NOW,
    },
    {
      authorizer: new HookAuthorizer({ gate }),
      mode: ENFORCEMENT_MODE.ENFORCE,
      sink: null,
      route,
    },
  );
}

const home = () => mkdtemp(join(tmpdir(), 'memnox-chat-approval-'));
const person = () => 'moise';

describe('a question the agent cannot show a prompt for', () => {
  it('is held, and the agent is told to ask the person here', async () => {
    const machine = await home();
    const first = await ask(machine, APPROVAL_ROUTE.SESSION);

    expect(first?.ruling.effect).toBe(DECISION_EFFECT.ASK);
    expect(first?.reply?.stdout).toContain('"permissionDecision":"deny"');
    expect(first?.reply?.stdout).toContain('Memnox is holding it as apr_');
    const held = await new PendingApprovals(machine).list(NOW.toISOString());
    expect(held).toHaveLength(1);
    expect(held[0]?.route).toBe(APPROVAL_ROUTE.SESSION);
  });

  it('asks once however many times the agent tries before an answer', async () => {
    const machine = await home();
    await ask(machine, APPROVAL_ROUTE.SESSION);
    await ask(machine, APPROVAL_ROUTE.SESSION);
    expect(await new PendingApprovals(machine).list(NOW.toISOString())).toHaveLength(1);
  });

  it('runs on the retry once the person says yes in the session', async () => {
    const machine = await home();
    await ask(machine, APPROVAL_ROUTE.SESSION);

    const said = await answerInChat(machine, 's1', 'yes', NOW, person);
    expect(said).toContain('allowed gh.');
    const retry = await ask(machine, APPROVAL_ROUTE.SESSION);

    expect(retry?.ruling.effect).toBe(DECISION_EFFECT.ALLOW);
    expect(retry?.ruling.reason).toContain('moise allowed this');
    // Once is once: the call after that is asked about again.
    expect((await ask(machine, APPROVAL_ROUTE.SESSION))?.ruling.effect).toBe(
      DECISION_EFFECT.ASK,
    );
  });

  it('stops asking after "allow for this session"', async () => {
    const machine = await home();
    await ask(machine, APPROVAL_ROUTE.SESSION);
    await answerInChat(machine, 's1', 'allow for this session', NOW, person);

    expect((await ask(machine, APPROVAL_ROUTE.SESSION))?.ruling.effect).toBe(
      DECISION_EFFECT.ALLOW,
    );
    expect((await ask(machine, APPROVAL_ROUTE.SESSION))?.ruling.effect).toBe(
      DECISION_EFFECT.ALLOW,
    );
  });

  it('refuses the retry in the person’s words after a no', async () => {
    const machine = await home();
    await ask(machine, APPROVAL_ROUTE.SESSION);
    await answerInChat(machine, 's1', 'no', NOW, person);

    const retry = await ask(machine, APPROVAL_ROUTE.SESSION);
    expect(retry?.ruling.effect).toBe(DECISION_EFFECT.DENY);
    expect(retry?.ruling.reason).toContain('moise said no to this');
  });

  it('reads an ordinary prompt as a prompt, never as an answer', async () => {
    const machine = await home();
    await ask(machine, APPROVAL_ROUTE.SESSION);
    expect(
      await answerInChat(machine, 's1', 'now refactor the billing module', NOW, person),
    ).toBeNull();
    expect(await answerInChat(machine, 'another', 'yes', NOW, person)).toBeNull();
  });
});

describe('a person who wants questions in their DM', () => {
  it('is never asked through the agent prompt, and a yes typed in the session does not count', async () => {
    const machine = await home();
    const first = await ask(machine, APPROVAL_ROUTE.DM, true);

    expect(first?.asked).toBe(false);
    expect(first?.reply?.stdout).toContain('sent to the person in Slack or Discord');
    expect(await answerInChat(machine, 's1', 'yes', NOW, person)).toBeNull();
  });

  it('runs on the retry once the DM answer lands', async () => {
    const machine = await home();
    await ask(machine, APPROVAL_ROUTE.DM);
    const approvals = new PendingApprovals(machine);
    const [held] = await approvals.list(NOW.toISOString());
    if (held === undefined) throw new Error('the question was held');
    await approvals.answer(held.id, 'once', 'moise in Slack', NOW.toISOString());

    expect((await ask(machine, APPROVAL_ROUTE.DM))?.ruling.effect).toBe(
      DECISION_EFFECT.ALLOW,
    );
  });
});

describe('where the route comes from', () => {
  it('is the session until config.toml says otherwise', async () => {
    const machine = await home();
    expect(await readApprovalRoute(machine)).toBe(APPROVAL_ROUTE.SESSION);
    await mkdir(join(machine, '.memnox'), { recursive: true });
    await writeFile(configPathFor(machine), 'approvals = "both"\n');
    expect(await readApprovalRoute(machine)).toBe(APPROVAL_ROUTE.BOTH);
  });
});
