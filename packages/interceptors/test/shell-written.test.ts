import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DECISION_EFFECT, ENFORCEMENT_MODE, TOOL_CLASS } from '@memnox/core';

import { EDIT_HOST } from '../src/agent-edits';
import type { EditHookContext } from '../src/edit-claims';
import {
  brokenByShell,
  keepBeforeShell,
  oweReport,
  takeOwedReport,
} from '../src/shell-written';
import type { ToolAnswer } from '../src/tool-hook';

/* `perl -pi` and a script show nothing before they run, so the tree is kept before an allowed
   command and compared after: a forbidden line it added is told to the agent to put right. */

const FINGERPRINT = `enforce:
  - name: writes-only-in-actions
    files: ["src/http/**"]
    forbid: ["*Repository.update(*"]
    reason: all database writes go through Actions
    instead: run an Action through actionFactory
`;

async function repository(fingerprint: string | null = FINGERPRINT): Promise<{
  repo: string;
  context: EditHookContext;
}> {
  const home = await mkdtemp(join(tmpdir(), 'memnox-shell-written-'));
  const repo = join(home, 'repo');
  await mkdir(join(repo, 'src', 'http'), { recursive: true });
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  };
  git('init', '-q');
  await writeFile(join(repo, 'src', 'http', 'Resource.java'), 'class Resource {}\n');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  if (fingerprint !== null) {
    await mkdir(join(repo, '.memnox'), { recursive: true });
    await writeFile(join(repo, '.memnox', 'code-fingerprint.yaml'), fingerprint);
  }
  const context = {
    home,
    agent: 'claude-code',
    runSession: undefined,
    pid: 1,
    cwd: repo,
    now: () => new Date('2026-09-28T10:00:00.000Z'),
  };
  return { repo, context };
}

function command(
  repo: string,
  effect: string = DECISION_EFFECT.ALLOW,
  sessionId = 's1',
): ToolAnswer {
  return {
    call: {
      host: EDIT_HOST.PRE_TOOL_USE,
      tool: 'Bash',
      sessionId,
      cwd: repo,
      requests: [],
      shell: "perl -pi -e 's/x/y/' src/http/Resource.java",
      nativeAsk: true,
    },
    ruling: {
      action: 'shell.execute',
      class: TOOL_CLASS.UNKNOWN,
      effect: effect as ToolAnswer['ruling']['effect'],
      mode: ENFORCEMENT_MODE.ENFORCE,
      reason: 'no rule covers it',
    },
    reply: null,
    asked: false,
  };
}

const call = { tool_use_id: 'toolu_1' };

describe('what a shell command wrote, read after it ran', () => {
  it('tells the agent to put right a forbidden line the command added', async () => {
    const { repo, context } = await repository();
    await keepBeforeShell(call, command(repo), context);
    await writeFile(
      join(repo, 'src', 'http', 'Resource.java'),
      'class Resource {\n  void archive() { orderRepository.update(b); }\n}\n',
    );

    const said = await brokenByShell(call, context, 's1');

    expect(said).toContain('writes-only-in-actions');
    expect(said).toContain('first in src/http/Resource.java');
    expect(said).toContain('Instead: run an Action through actionFactory');
    // Said once: the kept tree is gone, so the same call is never reported twice.
    expect(await brokenByShell(call, context, 's1')).toBeNull();
  });

  // The diff header is parsed by its prefix, so a person's own prefix settings must not move it.
  it.each([
    ['diff.noprefix', 'true'],
    ['diff.dstPrefix', 'new/'],
  ])('still reads the added lines where %s is set', async (key, value) => {
    const { repo, context } = await repository();
    execFileSync('git', ['config', key, value], { cwd: repo, stdio: 'ignore' });
    await keepBeforeShell(call, command(repo), context);
    await writeFile(
      join(repo, 'src', 'http', 'Resource.java'),
      'class Resource {\n  void archive() { orderRepository.update(b); }\n}\n',
    );

    expect(await brokenByShell(call, context, 's1')).toContain('writes-only-in-actions');
  });

  it('says nothing where the command added only what the fingerprint allows', async () => {
    const { repo, context } = await repository();
    await keepBeforeShell(call, command(repo), context);
    await writeFile(join(repo, 'src', 'http', 'Other.java'), 'class Other {}\n');

    expect(await brokenByShell(call, context, 's1')).toBeNull();
  });

  it('never touches the index the person stages from', async () => {
    const { repo, context } = await repository();
    const index = await readFile(join(repo, '.git', 'index'));
    await keepBeforeShell(call, command(repo), context);
    await writeFile(join(repo, 'src', 'http', 'New.java'), 'class New {}\n');
    await brokenByShell(call, context, 's1');

    expect(await readFile(join(repo, '.git', 'index'))).toEqual(index);
  });

  // Gemini and Windsurf send no id for a call, and run one command at a time in a session.
  it('pairs a command with its return by session where the host sends no id', async () => {
    const { repo, context } = await repository();
    await keepBeforeShell({}, command(repo), context);
    await writeFile(
      join(repo, 'src', 'http', 'Resource.java'),
      'orderRepository.update(b);\n',
    );

    expect(await brokenByShell({}, context, 'other')).toBeNull();
    expect(await brokenByShell({}, context, 's1')).toContain('writes-only-in-actions');
  });

  // Windsurf reads nothing back after a tool, so what it is owed refuses its next call once.
  it('keeps a report for a host that cannot hear it, and hands it over once', async () => {
    const { context } = await repository();
    await oweReport(context.home, 'w1', 'put these right');

    expect(await takeOwedReport(context.home, 'w2')).toBeNull();
    expect(await takeOwedReport(context.home, 'w1')).toBe('put these right');
    expect(await takeOwedReport(context.home, 'w1')).toBeNull();
  });

  it('keeps nothing for a refused command, a repository enforcing nothing, or no id and no session', async () => {
    const refused = await repository();
    const plain = await repository(null);
    const unnamed = await repository();

    await keepBeforeShell(
      call,
      command(refused.repo, DECISION_EFFECT.DENY),
      refused.context,
    );
    await keepBeforeShell(call, command(plain.repo), plain.context);
    await keepBeforeShell(
      {},
      command(unnamed.repo, DECISION_EFFECT.ALLOW, ''),
      unnamed.context,
    );
    for (const each of [refused, plain, unnamed]) {
      await writeFile(
        join(each.repo, 'src', 'http', 'Resource.java'),
        'orderRepository.update(b);\n',
      );
    }

    expect(await brokenByShell(call, refused.context, 's1')).toBeNull();
    expect(await brokenByShell(call, plain.context, 's1')).toBeNull();
    expect(await brokenByShell({}, unnamed.context, '')).toBeNull();
  });
});
