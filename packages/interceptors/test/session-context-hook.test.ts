import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTOR_TYPE,
  configPathFor,
  DECISION_EFFECT,
  DEFAULT_CONFIG,
  DEFAULT_NOTICE_SETTINGS,
  emptySeen,
  emptySignals,
  ENFORCEMENT_MODE,
  ENV_POLICIES,
  LocalGate,
  MOST_BOUNDARY_CHARS,
  MOST_DECISIONS_PER_CALL,
  NOTICE_MODE,
  renderConfig,
  UnusualNotice,
  writePolicyDocumentFile,
  type EnforcementMode,
  type EventQuery,
  type EventSink,
  type MemnoxEvent,
  type NoticeStore,
  type Policy,
  type SeenSet,
  type SessionSignals,
  writeProtectionStop,
} from '@memnox/core';
import { HookAuthorizer } from '../src/hook-authorizer';
import {
  learnFromAnswer,
  rememberQuestion,
  toolFingerprint,
} from '../src/prompt-answers';
import {
  answerSessionStart,
  decisionsAt,
  preToolContext,
  sessionStartOf,
  type SessionContextDeps,
} from '../src/session-context-hook';
import { answerToolCall } from '../src/tool-hook';

/**
 * Memnox inside the session: the boundary once at its start, a remembered decision where
 * the agent meets it and never twice, and a yes given in the agent's own prompt learned
 * from the tool running, since the host says nothing else about it.
 */

const NOW = new Date('2026-09-24T10:00:00.000Z');

const RULES: Policy[] = [
  {
    name: 'secrets-deny',
    match: { actions: ['filesystem.read'], targets: ['**/.ssh/**', '**/.env'] },
    decision: { effect: DECISION_EFFECT.DENY, reason: 'keys stay on this machine' },
  },
  {
    name: 'payments-ask',
    match: { actions: ['filesystem.write'], targets: ['**/payments/**'] },
    decision: {
      effect: DECISION_EFFECT.ASK,
      reason: 'Priya decided payments are reviewed',
    },
  },
  {
    name: 'payments-read',
    match: { actions: ['filesystem.read'], targets: ['**/payments/**'] },
    decision: { effect: DECISION_EFFECT.ALLOW, reason: 'reading payments is fine' },
  },
  {
    name: 'network-ask',
    match: { actions: ['http.request'] },
    decision: { effect: DECISION_EFFECT.ASK, reason: 'a person looks at new hosts' },
  },
];

async function machine(
  mode: EnforcementMode = ENFORCEMENT_MODE.ENFORCE,
): Promise<SessionContextDeps> {
  const home = await mkdtemp(join(tmpdir(), 'memnox-in-session-'));
  const repo = join(home, 'work', 'repo');
  await mkdir(repo, { recursive: true });
  const rules = join(repo, 'memnox.policies.toml');
  await writePolicyDocumentFile(rules, { version: 1, policies: RULES });
  await mkdir(join(configPathFor(home), '..'), { recursive: true });
  await writeFile(configPathFor(home), renderConfig({ ...DEFAULT_CONFIG, mode }));
  return {
    home,
    agent: 'claude-code',
    env: { [ENV_POLICIES]: rules },
    cwd: repo,
    now: () => NOW,
    rootOf: () => repo,
  };
}

describe('the boundary, when a session starts', () => {
  it('is read from a SessionStart payload, which Claude Code, Codex and Gemini CLI share', () => {
    expect(
      sessionStartOf({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/r' }),
    ).toEqual({
      sessionId: 's1',
      cwd: '/r',
    });
    expect(
      sessionStartOf({ hook_event_name: 'SessionEnd', session_id: 's1' }),
    ).toBeNull();
  });

  it('is added context naming the mode, the rules here and the boundary, within its bound', async () => {
    const deps = await machine();
    const said = await answerSessionStart({ sessionId: 's1' }, deps);
    const reply = JSON.parse(said) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };

    expect(reply.hookSpecificOutput.hookEventName).toBe('SessionStart');
    const text = reply.hookSpecificOutput.additionalContext;
    expect(text).toContain('enforce mode');
    expect(text).toContain('keys stay on this machine');
    expect(text).toContain('Priya decided payments are reviewed');
    expect(text).toContain(`Project boundary: ${deps.cwd}`);
    expect(text.length).toBeLessThanOrEqual(MOST_BOUNDARY_CHARS);
  });

  /* A stop turns every seam off, and a session that heard nothing would assume it was
     still being watched. */
  it('says protection is stopped, by whom, and how to turn it back on', async () => {
    const deps = await machine();
    await writeProtectionStop(deps.home, {
      at: '2026-09-24T09:00:00.000Z',
      by: 'moise',
      reason: 'demo',
      mode: ENFORCEMENT_MODE.ENFORCE,
    });

    const said = await answerSessionStart({ sessionId: 's1' }, deps);
    const text = (
      JSON.parse(said) as { hookSpecificOutput: { additionalContext: string } }
    ).hookSpecificOutput.additionalContext;

    expect(text).toContain('stopped');
    expect(text).toContain('moise');
    expect(text).toContain('memnox start');
  });

  it('says nothing when Memnox is off', async () => {
    expect(
      await answerSessionStart({ sessionId: 's1' }, await machine(ENFORCEMENT_MODE.OFF)),
    ).toBe('');
  });
});

describe('a remembered decision, where the agent meets it', () => {
  it('is said once per session, and a few at most per call', async () => {
    const deps = await machine();
    const lookup = {
      sessionId: 's1',
      subjects: [
        { action: 'filesystem.read', target: `${deps.cwd}/src/payments/charge.ts` },
        { action: 'filesystem.write', target: `${deps.cwd}/src/payments/charge.ts` },
        { action: 'http.request', target: 'api.example.com' },
      ],
    };

    const first = await decisionsAt(lookup, deps);
    expect(first?.split('\n')).toHaveLength(MOST_DECISIONS_PER_CALL);
    expect(first).toContain('A previous decision covers');
    const second = await decisionsAt(lookup, deps);
    expect(second?.split('\n')).toHaveLength(1);
    expect(await decisionsAt(lookup, deps)).toBeNull();
    // Another session has been told nothing yet.
    expect(await decisionsAt({ ...lookup, sessionId: 's2' }, deps)).not.toBeNull();
  });

  it('is found in the words of a prompt, and never for a prompt naming nothing', async () => {
    const deps = await machine();
    const said = await decisionsAt(
      { sessionId: 's1', prompt: 'tidy up payments/ please' },
      deps,
    );
    expect(said).toContain('covers payments/');
    expect(
      await decisionsAt({ sessionId: 's1', prompt: 'what time is it' }, deps),
    ).toBeNull();
  });

  it("rides beside a tool call in Claude Code's words, which leave the prompt to run", () => {
    expect(JSON.parse(preToolContext('x'))).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'x' },
    });
  });
});

class Rows implements EventSink {
  readonly appended: MemnoxEvent[] = [];
  async append(event: MemnoxEvent): Promise<void> {
    this.appended.push(event);
  }
  async query(_filter: EventQuery): Promise<MemnoxEvent[]> {
    return this.appended;
  }
}

class MemoryNotice implements NoticeStore {
  seen: SeenSet = emptySeen();
  writes = 0;
  readSeen(): SeenSet {
    return this.seen;
  }
  writeSeen(_agent: string, seen: SeenSet): void {
    this.seen = seen;
    this.writes += 1;
  }
  readSignals(): SessionSignals {
    return emptySignals();
  }
  writeSignals(): void {}
  startedAt(): string {
    return '2026-01-01T00:00:00.000Z';
  }
}

function noticingAuthorizer(store: MemoryNotice): HookAuthorizer {
  const gate = new LocalGate(RULES, { agentName: 'claude-code' });
  gate.attachNotice(
    new UnusualNotice({
      store,
      agent: 'claude-code',
      settings: { ...DEFAULT_NOTICE_SETTINGS, mode: NOTICE_MODE.ENFORCE },
      now: () => NOW,
    }),
  );
  return new HookAuthorizer({ gate });
}

function fetchCall(event: string, id = 'toolu_1'): Record<string, unknown> {
  return {
    hook_event_name: event,
    session_id: 's1',
    cwd: '/work/repo',
    permission_mode: 'default',
    tool_name: 'WebFetch',
    tool_use_id: id,
    tool_input: { url: 'https://api.example.com/v1' },
  };
}

async function askedAbout(deps: SessionContextDeps, id = 'toolu_1'): Promise<void> {
  const before = fetchCall('PreToolUse', id);
  const answer = await answerToolCall(
    before,
    { ...deps, runSession: undefined, personThere: true },
    {
      authorizer: noticingAuthorizer(new MemoryNotice()),
      mode: ENFORCEMENT_MODE.ENFORCE,
      sink: null,
    },
  );
  expect(answer?.asked).toBe(true);
  await rememberQuestion(before, answer!, { ...deps, runSession: undefined });
}

describe("a yes given in the agent's own prompt", () => {
  it('is recorded as the person allowing it, and teaches noticing the same new thing', async () => {
    const deps = await machine();
    await askedAbout(deps);
    const rows = new Rows();
    const notice = new MemoryNotice();

    const learned = await learnFromAnswer(fetchCall('PostToolUse'), {
      ...deps,
      runSession: undefined,
      sink: rows,
      authorizer: noticingAuthorizer(notice),
      mode: ENFORCEMENT_MODE.ENFORCE,
      person: () => 'dana',
    });

    expect(learned).toBe(true);
    expect(rows.appended).toHaveLength(1);
    expect(rows.appended[0]).toMatchObject({
      actorType: ACTOR_TYPE.HUMAN,
      effect: DECISION_EFFECT.ALLOW,
      operation: 'http.request',
      authorizedBy: 'dana (claude-code prompt)',
      sessionId: 's1',
    });
    expect(notice.writes).toBe(1);
    // Answered once: the same call returning again is not a second yes.
    expect(
      await learnFromAnswer(fetchCall('PostToolUse'), {
        ...deps,
        runSession: undefined,
        sink: rows,
      }),
    ).toBe(false);
  });

  it('leaves nothing for a tool that never ran, or one returning after the window', async () => {
    const deps = await machine();
    await askedAbout(deps);
    const rows = new Rows();

    // A different call returning is not the one asked about.
    expect(
      await learnFromAnswer(fetchCall('PostToolUse', 'toolu_other'), {
        ...deps,
        runSession: undefined,
        sink: rows,
      }),
    ).toBe(false);
    const late = {
      ...deps,
      runSession: undefined,
      sink: rows,
      now: () => new Date('2026-09-24T12:00:00.000Z'),
    };
    expect(await learnFromAnswer(fetchCall('PostToolUse'), late)).toBe(false);
    expect(rows.appended).toEqual([]);
  });

  it('fingerprints by the host id, or by the tool and its input where there is none', () => {
    expect(toolFingerprint(fetchCall('PreToolUse'))).toBe('toolu_1');
    const bare = { tool_name: 'Bash', tool_input: { command: 'ls', b: 1 } };
    const reordered = { tool_name: 'Bash', tool_input: { b: 1, command: 'ls' } };
    expect(toolFingerprint(bare)).toBe(toolFingerprint(reordered));
    expect(toolFingerprint('nope')).toBeNull();
  });
});
