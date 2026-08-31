import { DECISION_EFFECT, type ActionRequest } from '@memnox/core';
import { LocalGate } from '@memnox/local-gate';
import { describe, expect, it } from 'vitest';
import { HookAuthorizer, type HookVerdict } from '../src/hook-authorizer';
import { HookSession } from '../src/hook-session';
import {
  EXIT_OK,
  EXIT_UNUSABLE_INPUT,
  HOOK_EVENT_NAME,
  PERMISSION_DECISION,
} from '../src/tool-hook.constants';

interface Response {
  hookSpecificOutput: {
    hookEventName: string;
    permissionDecision: string;
    permissionDecisionReason: string;
  };
}

function payload(toolName: string, toolInput: Record<string, unknown>): string {
  return JSON.stringify({
    hook_event_name: HOOK_EVENT_NAME,
    session_id: 'ses_1',
    tool_name: toolName,
    tool_input: toolInput,
  });
}

/** Answers whatever it is told to, so the session is its own path to a response. */
class FixedAuthorizer {
  readonly seen: ActionRequest[] = [];
  constructor(private readonly verdict: HookVerdict) {}
  async authorize(request: ActionRequest): Promise<HookVerdict> {
    this.seen.push(request);
    return this.verdict;
  }
}

function sessionFor(verdict: HookVerdict): {
  session: HookSession;
  authorizer: FixedAuthorizer;
  logs: string[];
} {
  const authorizer = new FixedAuthorizer(verdict);
  const logs: string[] = [];
  const session = new HookSession({
    authorizer: authorizer as unknown as HookAuthorizer,
    log: (message) => logs.push(message),
  });
  return { session, authorizer, logs };
}

describe('HookSession', () => {
  it('says nothing about an allowed action, so the agent is never slowed by an allow', async () => {
    const { session } = sessionFor({ effect: DECISION_EFFECT.ALLOW, reason: 'fine' });
    const outcome = await session.handle(payload('Read', { file_path: 'README.md' }));
    expect(outcome).toEqual({ stdout: '', exitCode: EXIT_OK });
  });

  it('never answers "allow", which would skip a prompt the person would have seen', async () => {
    const { session } = sessionFor({ effect: DECISION_EFFECT.ALLOW, reason: 'fine' });
    const outcome = await session.handle(payload('Bash', { command: 'rm -rf /' }));
    expect(outcome.stdout).not.toContain('allow');
  });

  it('denies with the alternative, so the refusal is not a dead end', async () => {
    const { session } = sessionFor({
      effect: DECISION_EFFECT.WITHHOLD,
      reason: 'This task declared no credential need.',
      alternative: {
        action: 'filesystem.read',
        resource: '.env.example',
        note: '.env.example is readable',
      },
      decisionId: 'dec_01JQ2',
    });

    const outcome = await session.handle(payload('Read', { file_path: '.env' }));
    const response = JSON.parse(outcome.stdout) as Response;

    expect(outcome.exitCode).toBe(EXIT_OK);
    expect(response.hookSpecificOutput.hookEventName).toBe(HOOK_EVENT_NAME);
    expect(response.hookSpecificOutput.permissionDecision).toBe(PERMISSION_DECISION.DENY);
    expect(response.hookSpecificOutput.permissionDecisionReason).toContain(
      'Instead: filesystem.read .env.example',
    );
    expect(response.hookSpecificOutput.permissionDecisionReason).toContain(
      'memnox why dec_01JQ2',
    );
  });

  it('asks the person at the keyboard when the verdict escalates', async () => {
    const { session } = sessionFor({
      effect: DECISION_EFFECT.ESCALATE,
      reason: 'a deploy needs a person',
      approvalId: 'apr_7',
    });

    const response = JSON.parse(
      (await session.handle(payload('Bash', { command: 'deploy' }))).stdout,
    ) as Response;

    expect(response.hookSpecificOutput.permissionDecision).toBe(PERMISSION_DECISION.ASK);
    expect(response.hookSpecificOutput.permissionDecisionReason).toContain(
      'memnox approvals resolve apr_7',
    );
  });

  it('rules on nothing for a tool it does not hold, and asks nobody', async () => {
    const { session, authorizer } = sessionFor({
      effect: DECISION_EFFECT.WITHHOLD,
      reason: 'never reached',
    });
    const outcome = await session.handle(payload('TodoWrite', {}));
    expect(outcome).toEqual({ stdout: '', exitCode: EXIT_OK });
    expect(authorizer.seen).toEqual([]);
  });

  it('reports an unusable payload as a fault, never as a refusal', async () => {
    const { session, logs } = sessionFor({
      effect: DECISION_EFFECT.WITHHOLD,
      reason: 'never reached',
    });
    const outcome = await session.handle('{');
    expect(outcome).toEqual({ stdout: '', exitCode: EXIT_UNUSABLE_INPUT });
    expect(logs.join(' ')).toContain('ruled on nothing');
  });
});

/** Typed by inference: the shape is the policy file a person would write. */
const withholdEnv = {
  name: 'secrets-not-required',
  match: { actions: ['filesystem.read'], targets: ['*.env'] },
  decision: {
    effect: DECISION_EFFECT.WITHHOLD,
    reason: 'This task declared no credential need.',
    alternative: {
      action: 'filesystem.read',
      resource: '.env.example',
      note: '.env.example is readable',
    },
  },
};

describe('the two-minute demo, offline', () => {
  it('withholds a credential read and names the substitute, with no runtime at all', async () => {
    const session = new HookSession({
      authorizer: new HookAuthorizer({
        gate: new LocalGate([withholdEnv], { agentName: 'claude-code' }),
        log: () => {},
      }),
      log: () => {},
    });

    const response = JSON.parse(
      (await session.handle(payload('Read', { file_path: '/srv/app/.env' }))).stdout,
    ) as Response;

    expect(response.hookSpecificOutput.permissionDecision).toBe(PERMISSION_DECISION.DENY);
    expect(response.hookSpecificOutput.permissionDecisionReason).toContain(
      'Instead: filesystem.read .env.example',
    );
  });

  it('leaves the ordinary read alone', async () => {
    const session = new HookSession({
      authorizer: new HookAuthorizer({
        gate: new LocalGate([withholdEnv], { agentName: 'claude-code' }),
        log: () => {},
      }),
      log: () => {},
    });

    const outcome = await session.handle(
      payload('Read', { file_path: '/srv/app/README.md' }),
    );
    expect(outcome.stdout).toBe('');
  });
});
