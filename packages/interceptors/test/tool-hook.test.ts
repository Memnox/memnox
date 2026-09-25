import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DECISION_EFFECT,
  ENFORCEMENT_MODE,
  EVENT_SURFACE,
  EXECUTION,
  LocalGate,
  policiesFrom,
  recommendedAnswers,
  type EventQuery,
  type EventSink,
  type MemnoxEvent,
  type Policy,
} from '@memnox/core';
import { HookAuthorizer } from '../src/hook-authorizer';
import { toolCallOf } from '../src/tool-calls';
import {
  answerToolCall,
  failedToolAnswer,
  readMachineMode,
  type ToolHookContext,
} from '../src/tool-hook';
import { NO_WAY_TO_ASK } from '../src/tool-policy';

/**
 * The hook `setup` installs ruled on writes for leases and on nothing else, so an agent's
 * own Read of `~/.ssh/id_ed25519`, its WebFetch and its MCP calls met no rule at all
 * unless somebody had also run `protect --apply-native`. These pin the mapping from each
 * agent's tool to the action a rule names, the mode, the reply, and the row.
 */

const HOME = '/Users/dev';
const REPO = '/work/repo';

const RULES: Policy[] = [
  {
    name: 'secrets-deny',
    match: { actions: ['filesystem.read'], targets: ['**/.ssh/**', '**/.env'] },
    decision: { effect: DECISION_EFFECT.DENY, reason: 'keys stay on this machine' },
  },
  {
    name: 'network-ask',
    match: { actions: ['http.request'] },
    decision: { effect: DECISION_EFFECT.ASK, reason: 'a person looks at new hosts' },
  },
  {
    name: 'git-deny',
    match: { actions: ['git.push-force', 'git.push-f'] },
    decision: { effect: DECISION_EFFECT.DENY, reason: 'history is shared' },
  },
];

function authorizer(rules: Policy[] = RULES): HookAuthorizer {
  return new HookAuthorizer({ gate: new LocalGate(rules, { agentName: 'claude-code' }) });
}

class Rows implements EventSink {
  readonly appended: MemnoxEvent[] = [];
  async append(event: MemnoxEvent): Promise<void> {
    this.appended.push(event);
  }
  async query(_filter: EventQuery): Promise<MemnoxEvent[]> {
    return this.appended;
  }
}

function claude(tool: string, input: Record<string, unknown>, mode = 'default') {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    cwd: REPO,
    permission_mode: mode,
    tool_name: tool,
    tool_input: input,
  };
}

function context(personThere = true): ToolHookContext {
  return {
    home: HOME,
    agent: 'claude-code',
    runSession: undefined,
    env: {},
    personThere,
    now: () => new Date('2026-09-24T10:00:00.000Z'),
  };
}

describe("what each of an agent's own tools does, as a rule names it", () => {
  it('reads a file by its absolute path, with ~ and relative paths spelled out', () => {
    expect(
      toolCallOf(claude('Read', { file_path: '~/.ssh/id_ed25519' }), HOME)?.requests,
    ).toEqual([
      { action: 'filesystem.read', target: `${HOME}/.ssh/id_ed25519`, class: 'read' },
    ]);
    expect(
      toolCallOf(claude('Read', { file_path: '.env' }), HOME)?.requests[0]?.target,
    ).toBe(`${REPO}/.env`);
  });

  it('searches the working directory where Grep and Glob name no path', () => {
    expect(toolCallOf(claude('Grep', { pattern: 'x' }), HOME)?.requests[0]).toMatchObject(
      {
        action: 'filesystem.read',
        target: REPO,
      },
    );
    expect(
      toolCallOf(claude('Glob', { pattern: '*', path: `${HOME}/.aws` }), HOME)
        ?.requests[0],
    ).toMatchObject({ action: 'filesystem.read', target: `${HOME}/.aws` });
  });

  it('names a fetch by its host, and a search by nothing but what it carries', () => {
    const fetch = toolCallOf(
      claude('WebFetch', { url: 'https://evil.example/x?a=1' }),
      HOME,
    );
    expect(fetch?.requests[0]).toMatchObject({
      action: 'http.request',
      target: 'evil.example',
    });
    const search = toolCallOf(claude('WebSearch', { query: 'weather' }), HOME);
    expect(search?.requests[0]?.target).toBeUndefined();
    // Both only read, and say so, so a rule about changing a host lets them through.
    expect(search?.requests[0]?.arguments).toEqual({ method: 'GET', query: 'weather' });
    expect(fetch?.requests[0]?.arguments).toMatchObject({ method: 'GET' });
  });

  it('spells an MCP tool mcp.<server>.<tool>, and a write as filesystem.write', () => {
    const mcp = toolCallOf(claude('mcp__github__create_issue', { title: 't' }), HOME);
    expect(mcp?.requests[0]).toMatchObject({
      action: 'mcp.github.create_issue',
      target: 'github',
    });
    const write = toolCallOf(claude('Edit', { file_path: `${REPO}/a.ts` }), HOME);
    expect(write?.requests[0]).toMatchObject({ action: 'filesystem.write' });
  });

  it('hands a command line to the shell classifier and leaves unknown tools alone', () => {
    expect(toolCallOf(claude('Bash', { command: 'ls' }), HOME)?.shell).toBe('ls');
    expect(toolCallOf(claude('TodoWrite', { todos: [] }), HOME)).toBeNull();
    expect(
      toolCallOf({ hook_event_name: 'PostToolUse', tool_name: 'Read' }, HOME),
    ).toBeNull();
  });

  it("reads Gemini CLI's, Cursor's and Windsurf's own events", () => {
    const gemini = toolCallOf(
      {
        hook_event_name: 'BeforeTool',
        session_id: 'g',
        tool_name: 'read_file',
        tool_input: { absolute_path: `${HOME}/.ssh/id_rsa` },
      },
      HOME,
    );
    expect(gemini?.requests[0]?.target).toBe(`${HOME}/.ssh/id_rsa`);

    const shell = toolCallOf(
      { hook_event_name: 'beforeShellExecution', conversation_id: 'c', command: 'ls' },
      HOME,
    );
    expect(shell).toMatchObject({ host: 'cursor', shell: 'ls', nativeAsk: true });
    const read = toolCallOf(
      {
        hook_event_name: 'beforeReadFile',
        conversation_id: 'c',
        file_path: `${REPO}/.env`,
      },
      HOME,
    );
    expect(read?.requests[0]?.target).toBe(`${REPO}/.env`);

    const mcp = toolCallOf(
      {
        agent_action_name: 'pre_mcp_tool_use',
        trajectory_id: 't',
        tool_info: {
          mcp_server_name: 'slack',
          mcp_tool_name: 'post',
          mcp_tool_arguments: {},
        },
      },
      HOME,
    );
    expect(mcp?.requests[0]?.action).toBe('mcp.slack.post');
    const command = toolCallOf(
      {
        agent_action_name: 'pre_run_command',
        trajectory_id: 't',
        tool_info: { command_line: 'git push --force', cwd: REPO },
      },
      HOME,
    );
    expect(command).toMatchObject({
      host: 'windsurf',
      shell: 'git push --force',
      cwd: REPO,
    });
  });
});

describe('the verdict, the mode, and what the agent is told', () => {
  it('refuses a secret read in the words Claude Code reads, and records it', async () => {
    const rows = new Rows();
    const answer = await answerToolCall(
      claude('Read', { file_path: `${HOME}/.ssh/id_ed25519` }),
      context(),
      { authorizer: authorizer(), mode: ENFORCEMENT_MODE.ENFORCE, sink: rows },
    );

    const said = JSON.parse(answer?.reply?.stdout ?? '{}') as {
      hookSpecificOutput: {
        permissionDecision: string;
        permissionDecisionReason: string;
      };
    };
    expect(said.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(said.hookSpecificOutput.permissionDecisionReason).toContain('secrets-deny');
    expect(rows.appended).toHaveLength(1);
    expect(rows.appended[0]).toMatchObject({
      surface: EVENT_SURFACE.FILESYSTEM,
      operation: 'filesystem.read',
      effect: DECISION_EFFECT.DENY,
      mode: ENFORCEMENT_MODE.ENFORCE,
      rule: { name: 'secrets-deny' },
      sessionId: 's1',
    });
  });

  it('in observe, lets it run, says nothing, and records what enforce would have done', async () => {
    const rows = new Rows();
    const answer = await answerToolCall(
      claude('Read', { file_path: `${HOME}/.ssh/id_ed25519` }),
      context(),
      { authorizer: authorizer(), mode: ENFORCEMENT_MODE.OBSERVE, sink: rows },
    );

    expect(answer?.reply).toBeNull();
    expect(answer?.ruling.effect).toBe(DECISION_EFFECT.ALLOW);
    expect(rows.appended[0]).toMatchObject({
      effect: DECISION_EFFECT.ALLOW,
      shadowEffect: DECISION_EFFECT.DENY,
      mode: ENFORCEMENT_MODE.OBSERVE,
    });
  });

  it('says nothing about an allow no rule spoke to, so the agent asks its own questions', async () => {
    const rows = new Rows();
    const answer = await answerToolCall(
      claude('Read', { file_path: `${REPO}/README.md` }),
      context(),
      { authorizer: authorizer(), mode: ENFORCEMENT_MODE.ENFORCE, sink: rows },
    );
    expect(answer?.reply).toBeNull();
    expect(rows.appended).toEqual([]);
  });

  it('asks the person at Claude Code, and refuses where nobody will see the question', async () => {
    const seams = {
      authorizer: authorizer(),
      mode: ENFORCEMENT_MODE.ENFORCE,
      sink: null,
    };
    const fetch = claude('WebFetch', { url: 'https://api.example.com' });

    const asked = await answerToolCall(fetch, context(true), seams);
    expect(asked?.reply?.stdout).toContain('"permissionDecision":"ask"');

    const unattended = await answerToolCall(fetch, context(false), seams);
    expect(unattended?.reply?.stdout).toContain('"permissionDecision":"deny"');
    expect(unattended?.reply?.stdout).toContain(NO_WAY_TO_ASK);
  });

  /* A refused ask that is recorded with no ending is an approval the
     workspace's inbox shows as waiting for ever, on a call nothing holds. */
  it('records an ask nobody could be shown as blocked, and one put to a person as open', async () => {
    const rows = new Rows();
    const seams = {
      authorizer: authorizer(),
      mode: ENFORCEMENT_MODE.ENFORCE,
      sink: rows,
    };
    const fetch = claude('WebFetch', { url: 'https://api.example.com' });

    await answerToolCall(fetch, context(false), seams);
    await answerToolCall(fetch, context(true), seams);

    expect(rows.appended[0]).toMatchObject({
      effect: DECISION_EFFECT.ASK,
      execution: EXECUTION.BLOCKED,
    });
    expect(rows.appended[1]?.execution).toBeUndefined();
  });

  it('rules on a command line the way the shell seam does', async () => {
    const answer = await answerToolCall(
      claude('Bash', { command: 'git push --force origin main' }),
      context(),
      { authorizer: authorizer(), mode: ENFORCEMENT_MODE.ENFORCE, sink: null },
    );
    expect(answer?.ruling).toMatchObject({
      effect: DECISION_EFFECT.DENY,
      rule: 'git-deny',
    });

    const reading = await answerToolCall(
      claude('Bash', { command: `cat README.md ${HOME}/.ssh/id_ed25519` }),
      context(),
      { authorizer: authorizer(), mode: ENFORCEMENT_MODE.ENFORCE, sink: null },
    );
    expect(reading?.ruling).toMatchObject({
      effect: DECISION_EFFECT.DENY,
      rule: 'secrets-deny',
    });
  });

  it("answers Windsurf on stderr with exit 2, Gemini as a decision, and Cursor's allow as {}", async () => {
    const seams = {
      authorizer: authorizer(),
      mode: ENFORCEMENT_MODE.ENFORCE,
      sink: null,
    };
    const windsurf = await answerToolCall(
      {
        agent_action_name: 'pre_read_code',
        trajectory_id: 't',
        tool_info: { file_path: `${HOME}/.ssh/config` },
      },
      context(false),
      seams,
    );
    expect(windsurf?.reply).toMatchObject({ exitCode: 2 });
    expect(windsurf?.reply?.stderr).toContain('keys stay on this machine');

    const gemini = await answerToolCall(
      {
        hook_event_name: 'BeforeTool',
        session_id: 'g',
        tool_name: 'read_file',
        tool_input: { file_path: `${REPO}/.env` },
      },
      context(false),
      seams,
    );
    expect(JSON.parse(gemini?.reply?.stdout ?? '{}')).toMatchObject({ decision: 'deny' });

    const cursor = await answerToolCall(
      {
        hook_event_name: 'beforeReadFile',
        conversation_id: 'c',
        file_path: `${REPO}/a.ts`,
      },
      context(),
      seams,
    );
    expect(cursor?.reply).toEqual({ stdout: '{}' });
  });

  it('rules on nothing when the machine is off', async () => {
    const answer = await answerToolCall(
      claude('Read', { file_path: `${HOME}/.ssh/id_ed25519` }),
      context(),
      { authorizer: authorizer(), mode: ENFORCEMENT_MODE.OFF, sink: null },
    );
    expect(answer).toBeNull();
  });
});

describe("the machine's mode, read and never written", () => {
  it('observes where setup has written nothing, and reads what protect wrote', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-tool-mode-'));
    expect(await readMachineMode(home)).toBe(ENFORCEMENT_MODE.OBSERVE);

    await mkdir(join(home, '.memnox'));
    await writeFile(join(home, '.memnox', 'config.toml'), 'mode = "enforce"\n');
    expect(await readMachineMode(home)).toBe(ENFORCEMENT_MODE.ENFORCE);
  });
});

/* A hook that threw let every call through, enforce included, so a broken rule file
   was a quiet way to switch enforcement off. */
describe('when ruling fails', () => {
  const read = {
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    cwd: REPO,
    tool_name: 'Read',
    tool_input: { file_path: `${HOME}/.ssh/id_ed25519` },
  };

  it('refuses in enforce, and says the check could not run', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-tool-failed-'));
    await mkdir(join(home, '.memnox'));
    await writeFile(join(home, '.memnox', 'config.toml'), 'mode = "enforce"\n');

    const answer = await failedToolAnswer(read, home);

    expect(answer?.ruling.effect).toBe(DECISION_EFFECT.DENY);
    expect(answer?.reply?.stdout).toContain('could not be checked');
  });

  it('says nothing in observe, which never stopped anything', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-tool-failed-'));

    expect(await failedToolAnswer(read, home)).toBeNull();
  });
});

/* The proxy asks `mcp.<tool>` of a server and the hook asked `mcp.<server>.<tool>`, so a
   rule written for one seam let the same call through the other. */
describe('an MCP call, however its rule was spelled', () => {
  const blockedAtTheProxy: Policy[] = [
    {
      name: 'no-issue-writes',
      match: { actions: ['mcp.create_issue'], targets: ['github'] },
      decision: { effect: DECISION_EFFECT.DENY, reason: 'issues are filed by people' },
    },
  ];

  it('is refused through the hook by a rule written the way the proxy asks', async () => {
    const answer = await answerToolCall(
      claude('mcp__github__create_issue', { title: 'x' }),
      context(),
      {
        authorizer: authorizer(blockedAtTheProxy),
        mode: ENFORCEMENT_MODE.ENFORCE,
        sink: null,
      },
    );

    expect(answer?.ruling.effect).toBe(DECISION_EFFECT.DENY);
  });
});

/* A freeze is somebody stopping this agent on purpose. In observe the hook only recorded
   what it would have refused, so on a laptop still watching a freeze stopped nothing. */
describe('a frozen agent, on a machine that is only watching', () => {
  it('is refused anyway', async () => {
    const frozen = new HookAuthorizer({
      gate: new LocalGate(
        [
          {
            name: 'allow-everything',
            match: { actions: ['*'] },
            decision: { effect: DECISION_EFFECT.ALLOW },
          },
        ],
        { agentName: 'claude-code', stateFacts: ['freeze:agent:claude-code'] },
      ),
    });

    const answer = await answerToolCall(
      claude('Bash', { command: 'git push' }),
      context(),
      { authorizer: frozen, mode: ENFORCEMENT_MODE.OBSERVE, sink: null },
    );

    expect(answer?.ruling.effect).toBe(DECISION_EFFECT.DENY);
  });
});

/* An agent in auto mode was refused a WebFetch of a toolkit's documentation, because the
   network rule asked about every request and nobody could be asked. */
describe('reading the web while changing nothing', () => {
  const baseline = policiesFrom(recommendedAnswers());
  const seams = {
    authorizer: authorizer(baseline),
    mode: ENFORCEMENT_MODE.ENFORCE,
    sink: null,
  };
  const docs = 'https://docs.composio.dev/toolkits/discordbot';

  it('lets a fetch and a search through with nobody there to ask', async () => {
    const fetch = claude('WebFetch', { url: docs, prompt: 'the trigger slugs' }, 'auto');
    const search = claude('WebSearch', { query: 'composio discordbot' }, 'auto');
    for (const call of [fetch, search]) {
      const answer = await answerToolCall(call, context(false), seams);
      expect(answer?.ruling.effect ?? DECISION_EFFECT.ALLOW).toBe(DECISION_EFFECT.ALLOW);
      expect(answer?.reply ?? null).toBeNull();
    }
  });

  it('lets a plain curl through and still stops one that posts', async () => {
    const read = claude('Bash', { command: `curl -s ${docs}` }, 'auto');
    const post = claude(
      'Bash',
      { command: 'curl -X POST https://api.example.com/messages -d text=hi' },
      'auto',
    );
    const readAnswer = await answerToolCall(read, context(false), seams);
    expect(readAnswer?.ruling.effect ?? DECISION_EFFECT.ALLOW).toBe(
      DECISION_EFFECT.ALLOW,
    );
    const postAnswer = await answerToolCall(post, context(false), seams);
    expect(postAnswer?.ruling.effect).toBe(DECISION_EFFECT.ASK);
    expect(postAnswer?.reply?.stdout).toContain('"permissionDecision":"deny"');
  });
});

describe('MCP tools and CLIs through the hook', () => {
  const seams = {
    authorizer: authorizer(policiesFrom(recommendedAnswers())),
    mode: ENFORCEMENT_MODE.ENFORCE,
    sink: null,
  };
  const effectOf = async (
    tool: string,
    input: Record<string, unknown>,
  ): Promise<string> =>
    (await answerToolCall(claude(tool, input, 'auto'), context(false), seams))?.ruling
      .effect ?? DECISION_EFFECT.ALLOW;

  it('lets an MCP tool that reads through, and asks about one that writes', async () => {
    expect(await effectOf('mcp__github__list_issues', { repo: 'a/b' })).toBe(
      DECISION_EFFECT.ALLOW,
    );
    expect(await effectOf('mcp__github__create_issue', { title: 't' })).toBe(
      DECISION_EFFECT.ASK,
    );
  });

  it('lets gh read a pull request and asks before it merges one', async () => {
    expect(await effectOf('Bash', { command: 'gh pr view 12' })).toBe(
      DECISION_EFFECT.ALLOW,
    );
    expect(await effectOf('Bash', { command: 'gh pr merge 12' })).toBe(
      DECISION_EFFECT.ASK,
    );
  });

  it('reads what aws and gh api read, and asks before either changes something', async () => {
    const effect = (command: string): Promise<string> => effectOf('Bash', { command });
    expect(await effect('aws ec2 describe-instances')).toBe(DECISION_EFFECT.ALLOW);
    expect(await effect('gh api repos/o/r/pulls')).toBe(DECISION_EFFECT.ALLOW);
    expect(await effect('aws s3 sync ./build s3://site')).toBe(DECISION_EFFECT.ASK);
    expect(await effect('gh api -X POST repos/o/r/issues')).toBe(DECISION_EFFECT.ASK);
    expect(await effect('gh api repos/o/r/issues -f title=t')).toBe(DECISION_EFFECT.ASK);
  });

  it('leaves an install and a test run alone', async () => {
    expect(await effectOf('Bash', { command: 'npm install' })).toBe(
      DECISION_EFFECT.ALLOW,
    );
    expect(await effectOf('Bash', { command: 'npm run test' })).toBe(
      DECISION_EFFECT.ALLOW,
    );
  });
});
