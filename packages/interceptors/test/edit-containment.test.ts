import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROBATION_KIND, ProbationRegister, SessionContainments } from '@memnox/core';
import { EDIT_HOST, EDIT_MOMENT, type AgentEdits } from '../src/agent-edits';
import { containmentFor } from '../src/containment-loader';
import type { EditHookContext } from '../src/edit-claims';
import { containedEdit } from '../src/edit-containment';

const NOW = new Date('2026-09-24T10:00:00.000Z');
const REPO = '/work/shop';

function context(home: string, agent = 'claude-code'): EditHookContext {
  return { home, agent, runSession: undefined, pid: 1, cwd: REPO, now: () => NOW };
}

function edits(
  path: string,
  host: AgentEdits['host'] = EDIT_HOST.PRE_TOOL_USE,
): AgentEdits {
  return {
    moment: EDIT_MOMENT.BEFORE,
    host,
    edits: [{ path, sessionId: 's1', cwd: REPO }],
  };
}

/** A machine in enforce, since observe holds nothing back and these are about what is held. */
async function home(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), 'memnox-edit-containment-'));
  await mkdir(join(made, '.memnox'));
  await writeFile(join(made, '.memnox', 'config.toml'), 'mode = "enforce"\n');
  return made;
}

describe('a hooked agent writing outside its repository', () => {
  it('is asked about in Claude Code, where its person sees the prompt', async () => {
    const reply = await containedEdit(
      edits('/etc/hosts'),
      true,
      context(await home()),
      () => REPO,
    );
    const parsed = JSON.parse(reply ?? '{}') as {
      hookSpecificOutput: {
        permissionDecision: string;
        permissionDecisionReason: string;
      };
    };
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('ask');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(
      'outside /work/shop',
    );
  });

  it('is refused in the host’s own words where nobody can be asked', async () => {
    const reply = await containedEdit(
      edits('/etc/hosts', EDIT_HOST.CURSOR),
      false,
      context(await home(), 'cursor'),
      () => REPO,
    );
    const parsed = JSON.parse(reply ?? '{}') as {
      permission: string;
      agent_message: string;
    };
    expect(parsed.permission).toBe('deny');
    expect(parsed.agent_message).toContain('Ask the person you work for');
  });

  it('writes inside the repository without a word', async () => {
    expect(
      await containedEdit(edits('src/app.ts'), true, context(await home()), () => REPO),
    ).toBeNull();
  });

  it('says nothing outside a checkout, where there is no boundary to keep', async () => {
    expect(
      await containedEdit(edits('/etc/hosts'), true, context(await home()), () => null),
    ).toBeNull();
  });
});

describe('a hooked agent still on probation', () => {
  it('is asked about even inside its repository, and told how it ends', async () => {
    const dir = await home();
    await new ProbationRegister(dir).start(
      { kind: PROBATION_KIND.AGENT, name: 'claude-code', label: 'Claude Code' },
      NOW,
    );
    const reply = await containedEdit(
      edits('src/app.ts'),
      true,
      context(dir),
      () => REPO,
    );
    expect(reply).toContain('Claude Code is on probation until');
    expect(reply).toContain('memnox agents trust claude-code');
  });
});

describe('what a seam reads as the session’s containment', () => {
  it('takes the repository `memnox run` recorded over the one the command runs in', async () => {
    const dir = await home();
    await new SessionContainments(dir).declare({
      sessionId: 'ses_1',
      agent: 'codex-cli',
      root: REPO,
      untrusted: true,
      startedAt: NOW.toISOString(),
    });
    const containment = await containmentFor({
      home: dir,
      env: { MEMNOX_SESSION: 'ses_1' },
      cwd: '/somewhere/else',
      now: NOW,
      rootOf: () => '/somewhere/else',
    });
    expect(containment?.root).toBe(REPO);
    expect(containment?.untrusted).toBe(true);
  });

  it('names a hooked agent from its own marker when no Memnox variable is set', async () => {
    const dir = await home();
    await new ProbationRegister(dir).start(
      { kind: PROBATION_KIND.AGENT, name: 'claude-code' },
      NOW,
    );
    const containment = await containmentFor({
      home: dir,
      env: { CLAUDECODE: '1' },
      cwd: dir,
      now: NOW,
      rootOf: () => null,
    });
    expect(containment?.probation?.name).toBe('claude-code');
  });

  it('is nothing at all where there is no repository, no session and no probation', async () => {
    const dir = await home();
    expect(
      await containmentFor({
        home: dir,
        env: {},
        cwd: dir,
        now: NOW,
        rootOf: () => null,
      }),
    ).toBeNull();
  });
});

/* Every machine starts in observe, and a boundary that refused there would stop Cursor
   writing outside its repository on the first day, while setup says it is only watching. */
describe('on a machine that is only watching', () => {
  it('holds nothing back', async () => {
    const watching = await mkdtemp(join(tmpdir(), 'memnox-edit-containment-'));

    expect(
      await containedEdit(
        edits('/etc/hosts', EDIT_HOST.CURSOR),
        false,
        context(watching),
        () => REPO,
      ),
    ).toBeNull();
  });
});
