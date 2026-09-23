import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  AutoCheckpoints,
  CHECKPOINT_KIND,
  Milestones,
  NodeGit,
  NodeWorktree,
  SqliteEventStore,
  type CheckpointMark,
  type MemnoxEvent,
} from '@memnox/core';
import {
  answerText,
  bounded,
  masked,
  MOST_ANSWER_CHARS,
  MOST_FIELD_CHARS,
  MOST_ROWS,
} from '../src/session-tools/bounded';
import type { SessionToolDeps } from '../src/session-tools/read-tools';
import { REWIND_OPERATION, type RewindSeams } from '../src/session-tools/rewind-tool';
import { serveSession } from '../src/session-tools/session-server';
import { NEVER_OFFERED, SESSION_TOOLS } from '../src/session-tools/session-tools';
import { agentFrom, isUnattended } from '../src/session-tools/session-cli';

/**
 * The tools an agent can call when its person asks Memnox something from inside the
 * conversation: what they are, what they may never be, and how much they may say.
 */

const NOW = new Date('2026-09-24T12:00:00.000Z');
const AGENT = 'claude-code';

function event(id: string, minute: number, over: Partial<MemnoxEvent> = {}): MemnoxEvent {
  return {
    id,
    schemaVersion: 1,
    at: `2026-09-24T10:${String(minute).padStart(2, '0')}:00.000Z`,
    sessionId: 'ses_mine',
    agent: AGENT,
    actorType: 'agent',
    surface: 'shell',
    operation: 'npm.test',
    class: 'read',
    effect: 'allow',
    mode: 'enforce',
    reason: 'no rule matched',
    ...over,
  };
}

async function machine(events: MemnoxEvent[] = []): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'memnox-session-tools-'));
  const store = SqliteEventStore.forHome(home);
  for (const each of events) await store.append(each);
  store.close();
  return home;
}

function depsFor(home: string, cwd = home): SessionToolDeps {
  return {
    home,
    cwd,
    agent: AGENT,
    env: {},
    now: () => NOW,
    readStatus: async () => ({ mode: 'observe', rules: 3 }),
    milestonesAt: async () => [],
  };
}

function seamsFor(
  over: Partial<Omit<RewindSeams, 'confirm'>> = {},
): Omit<RewindSeams, 'confirm'> {
  return {
    build: (cwd) => new Milestones(new NodeGit(cwd), new NodeWorktree(cwd)),
    unattended: () => false,
    terminal: () => true,
    ...over,
  };
}

interface Reply {
  id?: string | number | null;
  method?: string;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

interface Exchange {
  deps: SessionToolDeps;
  seams?: Omit<RewindSeams, 'confirm'>;
  capabilities?: Record<string, unknown>;
  /** What the person answers when the server asks through the host. */
  elicited?: 'accept' | 'decline';
}

/** One tool call over the wire, after the handshake, answering any question the server asks. */
async function call(
  exchange: Exchange,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean; asked: number }> {
  const input = new PassThrough();
  const output = new PassThrough();
  const replies: Reply[] = [];
  let asked = 0;
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => {
    for (const line of chunk.split('\n').filter((each) => each !== '')) {
      const reply = JSON.parse(line) as Reply;
      replies.push(reply);
      if (reply.method === 'elicitation/create') {
        asked += 1;
        input.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: reply.id, result: { action: exchange.elicited ?? 'decline' } })}\n`,
        );
      }
      if (reply.id === 2) input.end();
    }
  });
  const served = serveSession({
    input,
    output,
    deps: exchange.deps,
    seams: exchange.seams ?? seamsFor(),
  });
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: exchange.capabilities ?? {} },
  };
  const request = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name, arguments: args },
  };
  input.write(`${JSON.stringify(initialize)}\n${JSON.stringify(request)}\n`);
  await served;
  const result = replies.find((each) => each.id === 2)?.result ?? {};
  const content = result['content'] as { text: string }[];
  return { text: content[0]?.text ?? '', isError: result['isError'] === true, asked };
}

describe('the session tools', () => {
  it('offers exactly why, status, replay, decisions and rewind', () => {
    expect(SESSION_TOOLS.map((tool) => tool.name)).toEqual([
      'why',
      'status',
      'replay',
      'decisions',
      'rewind',
    ]);
  });

  it('offers nothing that allows, approves, trusts, unfreezes, changes a mode or a rule', () => {
    for (const tool of SESSION_TOOLS) {
      for (const word of NEVER_OFFERED)
        expect(tool.name.toLowerCase()).not.toContain(word);
    }
  });

  it('marks every tool read only except rewind, so the host asks the person about that one', () => {
    const acting = SESSION_TOOLS.filter((tool) => !tool.annotations.readOnlyHint);
    expect(acting.map((tool) => tool.name)).toEqual(['rewind']);
    expect(acting[0]?.annotations.destructiveHint).toBe(true);
  });

  it('answers tools/list over the wire with the same list', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => (text += chunk));
    const served = serveSession({
      input,
      output,
      deps: depsFor('/nowhere'),
      seams: seamsFor(),
    });
    input.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
    await served;
    const tools = (JSON.parse(text) as Reply).result?.['tools'] as { name: string }[];
    expect(tools.map((tool) => tool.name)).toContain('rewind');
    expect(tools.map((tool) => tool.name)).not.toContain('approve');
  });

  it('refuses a tool it never offered', async () => {
    const answer = await call({ deps: depsFor(await machine()) }, 'approve');
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('No tool approve');
  });

  it('reads the agent from the launch line, and knows CI when it sees it', () => {
    expect(agentFrom(['--agent', 'codex-cli'])).toBe('codex-cli');
    expect(agentFrom([])).toBe('unknown-agent');
    expect(isUnattended({ CI: 'true' })).toBe(true);
    expect(isUnattended({ CI: 'false' })).toBe(false);
    expect(isUnattended({})).toBe(false);
  });
});

describe('what a session tool may say', () => {
  it('clips every field, caps every list, and cuts the whole answer', () => {
    const long = 'x'.repeat(MOST_FIELD_CHARS * 3);
    const clipped = bounded({
      reason: long,
      rows: Array.from({ length: 500 }, (_, at) => at),
    });
    const record = clipped as { reason: string; rows: unknown[] };
    expect(record.reason.length).toBeLessThan(MOST_FIELD_CHARS + 20);
    expect(record.rows.length).toBe(MOST_ROWS + 1);
    const huge = answerText(Array.from({ length: 5_000 }, () => ({ a: long, b: long })));
    expect(huge.length).toBeLessThan(MOST_ANSWER_CHARS + 100);
  });

  it('masks anything shaped like a credential', () => {
    const said = masked(
      'curl -H "Authorization: Bearer abcdefghijklmnop" token=hunter22 ghp_abcdefghijklmnopqrstuvwx',
    );
    expect(said).not.toContain('abcdefghijklmnop');
    expect(said).not.toContain('hunter22');
    expect(said).not.toContain('ghp_');
    expect(said).toContain('token=[redacted]');
  });
});

describe('why', () => {
  it('explains the latest refusal in this agent session, with rule, source and alternative', async () => {
    const home = await machine([
      event('other', 1, {
        agent: 'cursor',
        sessionId: 'ses_theirs',
        effect: 'deny',
        reason: 'theirs',
      }),
      event('push', 2, {
        operation: 'git.push-force',
        effect: 'deny',
        reason: 'force pushes rewrite shared history',
        rule: {
          name: 'no force push',
          layer: 'project',
          file: 'memnox.policies.toml',
          line: 7,
        },
        alternative: { action: 'git.push', note: 'push a branch and open a PR' },
        argsDigest: 'sha256:secretdigest',
      }),
      event('later', 3),
    ]);
    const answer = await call({ deps: depsFor(home) }, 'why');
    expect(answer.text).toContain('no force push');
    expect(answer.text).toContain('memnox.policies.toml:7');
    expect(answer.text).toContain('push a branch and open a PR');
    expect(answer.text).toContain('this agent, latest session');
    expect(answer.text).not.toContain('theirs');
    expect(answer.text).not.toContain('secretdigest');
  });

  it('reads the run memnox named when the agent was launched by it', async () => {
    const home = await machine([
      event('mine', 1, {
        sessionId: 'ses_run',
        effect: 'ask',
        reason: 'held for a person',
      }),
      event('newer', 2, {
        sessionId: 'ses_newer',
        effect: 'deny',
        reason: 'a later session',
      }),
    ]);
    const deps = { ...depsFor(home), env: { MEMNOX_SESSION: 'ses_run' } };
    const answer = await call({ deps }, 'why');
    expect(answer.text).toContain('held for a person');
    expect(answer.text).not.toContain('a later session');
  });
});

describe('status, replay and decisions', () => {
  it('reports the status fields', async () => {
    const answer = await call({ deps: depsFor(await machine()) }, 'status');
    expect(JSON.parse(answer.text)).toEqual({ mode: 'observe', rules: 3 });
  });

  it('replays a long session compactly, newest steps last and the list capped', async () => {
    const events = Array.from({ length: 120 }, (_, at) =>
      event(`e${at}`, at % 60, {
        at: new Date(NOW.getTime() - (120 - at) * 1_000).toISOString(),
      }),
    );
    const answer = await call({ deps: depsFor(await machine(events)) }, 'replay');
    const replay = JSON.parse(answer.text) as { steps: string[]; sessionId: string };
    expect(replay.sessionId).toBe('ses_mine');
    expect(replay.steps.length).toBe(MOST_ROWS + 1);
    expect(replay.steps[0]).toContain('earlier row(s) left out');
    expect(answer.text.length).toBeLessThanOrEqual(MOST_ANSWER_CHARS + 60);
  });

  it('says which rules cover an action, and changes nothing', async () => {
    const home = await machine();
    const answer = await call({ deps: depsFor(home) }, 'decisions', {
      action: 'git.push',
    });
    expect(answer.isError).toBe(false);
    expect(answer.text).toContain('"action": "git.push"');
    expect(answer.text).toContain('Nothing was run');
  });

  it('asks for an action or a path rather than guessing', async () => {
    const answer = await call({ deps: depsFor(await machine()) }, 'decisions');
    expect(answer.text).toContain('name an action, a path, or both');
  });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

class MemoryMarks {
  marks: CheckpointMark[] = [];
  async read(): Promise<CheckpointMark[]> {
    return this.marks;
  }
  async write(marks: readonly CheckpointMark[]): Promise<void> {
    this.marks = [...marks];
  }
}

/** A repository an agent wrote into after its first milestone. */
async function wreckedRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'memnox-session-rewind-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(root, 'a.txt'), 'first\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'start');
  await new AutoCheckpoints({ marks: new MemoryMarks() }).before({
    sessionId: 'ses_mine',
    agent: AGENT,
    place: root,
    kind: CHECKPOINT_KIND.FIRST_WRITE,
    at: '2026-09-24T10:00:00.000Z',
  });
  await writeFile(join(root, 'a.txt'), 'the agent was here\n');
  return root;
}

async function rewindRows(home: string): Promise<MemnoxEvent[]> {
  const store = SqliteEventStore.forHome(home);
  try {
    return (await store.query({ limit: 50 })).filter(
      (each) => each.operation === REWIND_OPERATION,
    );
  } finally {
    store.close();
  }
}

describe('rewind', () => {
  it('refuses where nobody is at the machine, touches nothing, and records the request', async () => {
    const home = await machine();
    const root = await wreckedRepository();
    const seams = seamsFor({ unattended: () => true });
    const answer = await call({ deps: depsFor(home, root), seams }, 'rewind');
    expect(answer.text).toContain('Nobody is at this machine');
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('the agent was here\n');
    const rows = await rewindRows(home);
    expect(rows.map((row) => row.effect)).toEqual(['deny']);
  });

  it('refuses with no terminal and no way for the host to ask', async () => {
    const home = await machine();
    const root = await wreckedRepository();
    const answer = await call(
      { deps: depsFor(home, root), seams: seamsFor({ terminal: () => false }) },
      'rewind',
    );
    expect(answer.text).toContain('"rewound": false');
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('the agent was here\n');
  });

  it('asks the person through the host where it can, and a no is a no', async () => {
    const home = await machine();
    const root = await wreckedRepository();
    const exchange = {
      deps: depsFor(home, root),
      capabilities: { elicitation: {} },
      elicited: 'decline' as const,
    };
    const answer = await call(exchange, 'rewind');
    expect(answer.asked).toBe(1);
    expect(answer.text).toContain('The person said no');
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('the agent was here\n');
  });

  it('puts the last session back, keeping the current files first so it can be undone', async () => {
    const home = await machine();
    const root = await wreckedRepository();
    const exchange = {
      deps: depsFor(home, root),
      capabilities: { elicitation: {} },
      elicited: 'accept' as const,
    };
    const answer = await call(exchange, 'rewind');
    const said = JSON.parse(answer.text) as {
      rewound: boolean;
      yourWorkKeptAs: string;
      undo: string;
    };
    expect(said.rewound).toBe(true);
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('first\n');
    expect(said.undo).toBe(`memnox rewind --to ${said.yourWorkKeptAs}`);
    const rows = await rewindRows(home);
    expect(rows.map((row) => row.effect)).toEqual(['allow']);
  });
});
