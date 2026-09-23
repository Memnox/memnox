import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LeaseGate, LeaseRegistry, type LeaseHolder } from '@memnox/core';
import {
  afterEdit,
  canAskPerson,
  claimEdit,
  editAsk,
  editDenial,
  editOf,
} from '../src/edit-hook';
import { endedSessionOf } from '../src/agent-edits';
import type { SeamLeases } from '../src/seam-runtime';

const ROOT = '/work/repo';
const NOW = '2026-09-22T10:00:00.000Z';

const home = (): Promise<string> => mkdtemp(join(tmpdir(), 'memnox-edit-hook-'));
const directories = (path: string): boolean => !path.includes('.');

const leasesFor = (registry: LeaseRegistry, holder: LeaseHolder): SeamLeases => ({
  gate: new LeaseGate({
    registry,
    now: () => NOW,
    sleep: async () => undefined,
    ceilingMs: 10,
    pollMs: 5,
  }),
  holder,
  repositoryRoot: ROOT,
  isDirectory: directories,
});

const edit = (session: string, tool = 'Edit') => ({
  hook_event_name: 'PreToolUse',
  session_id: session,
  cwd: ROOT,
  tool_name: tool,
  tool_input: { file_path: `${ROOT}/src/billing/invoice.ts`, old_string: 'a' },
});

describe('reading what an editor is about to write', () => {
  it('reads the file from each tool that writes one', () => {
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      expect(editOf(edit('s1', tool))).toEqual({
        path: `${ROOT}/src/billing/invoice.ts`,
        sessionId: 's1',
        cwd: ROOT,
      });
    }
    expect(
      editOf({
        hook_event_name: 'PreToolUse',
        session_id: 's1',
        tool_name: 'NotebookEdit',
        tool_input: { notebook_path: `${ROOT}/analysis.ipynb` },
      }),
    ).toMatchObject({ path: `${ROOT}/analysis.ipynb` });
  });

  it('reads nothing from a read or a payload it does not know', () => {
    expect(editOf({ ...edit('s1'), tool_name: 'Read' })).toBeNull();
    expect(editOf({ ...edit('s1'), session_id: '' })).toBeNull();
    expect(editOf('not a payload')).toBeNull();
  });

  it('knows a session ending apart from a write', () => {
    expect(endedSessionOf({ hook_event_name: 'SessionEnd', session_id: 's1' })).toBe(
      's1',
    );
    expect(endedSessionOf(edit('s1'))).toBeNull();
  });

  it('refuses in the shape the host reads, naming why', () => {
    const answer = JSON.parse(editDenial('claude-code holds src/billing.')) as {
      hookSpecificOutput: {
        permissionDecision: string;
        permissionDecisionReason: string;
      };
    };
    expect(answer.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(answer.hookSpecificOutput.permissionDecisionReason).toContain(
      'claude-code holds src/billing.',
    );
  });
});

/* Claude Code writes files from inside the agent, so two sessions editing one file
   never met a lease: the shell seam only sees what goes through a shell. */
describe('two editor sessions on one file', () => {
  it('lets the first write and refuses the second, naming the first', async () => {
    const registry = new LeaseRegistry(await home(), () => true);
    const first = { agent: 'claude-code', sessionId: 's1', pid: 101 };
    const second = { agent: 'claude-code', sessionId: 's2', pid: 202 };

    const parsedFirst = editOf(edit('s1'));
    const parsedSecond = editOf(edit('s2'));
    if (parsedFirst === null || parsedSecond === null) throw new Error('unread');

    expect(await claimEdit(parsedFirst, leasesFor(registry, first))).toBeNull();
    const refused = await claimEdit(parsedSecond, leasesFor(registry, second));

    expect(refused?.reason).toContain('claude-code');
    expect(refused?.reason).toContain('src/billing/invoice.ts');
  });

  it('lets two sessions write two files in one folder', async () => {
    const registry = new LeaseRegistry(await home(), () => true);
    const first = { agent: 'claude-code', sessionId: 's1', pid: 101 };
    const second = { agent: 'claude-code', sessionId: 's2', pid: 202 };
    const parsedFirst = editOf(edit('s1'));
    const sibling = editOf({
      ...edit('s2'),
      tool_input: { file_path: `${ROOT}/src/billing/refund.ts` },
    });
    if (parsedFirst === null || sibling === null) throw new Error('unread');

    expect(await claimEdit(parsedFirst, leasesFor(registry, first))).toBeNull();
    expect(await claimEdit(sibling, leasesFor(registry, second))).toBeNull();
  });

  it('still waits on a folder a shell write is holding', async () => {
    const registry = new LeaseRegistry(await home(), () => true);
    const shell = { agent: 'cursor', sessionId: 's0', pid: 100 };
    const editor = { agent: 'claude-code', sessionId: 's1', pid: 101 };
    await registry.take({ path: 'src/billing', holder: shell }, NOW);
    const parsed = editOf(edit('s1'));
    if (parsed === null) throw new Error('unread');

    expect((await claimEdit(parsed, leasesFor(registry, editor)))?.reason).toContain(
      'cursor',
    );
  });

  it('lets one session keep writing the file it already holds', async () => {
    const registry = new LeaseRegistry(await home(), () => true);
    const holder = { agent: 'claude-code', sessionId: 's1', pid: 101 };
    const parsed = editOf(edit('s1'));
    if (parsed === null) throw new Error('unread');

    expect(await claimEdit(parsed, leasesFor(registry, holder))).toBeNull();
    expect(await claimEdit(parsed, leasesFor(registry, holder))).toBeNull();
  });

  it('lets the second in once the first session has ended', async () => {
    const registry = new LeaseRegistry(await home(), () => true);
    const first = { agent: 'claude-code', sessionId: 's1', pid: 101 };
    const second = { agent: 'claude-code', sessionId: 's2', pid: 202 };
    const parsedFirst = editOf(edit('s1'));
    const parsedSecond = editOf(edit('s2'));
    if (parsedFirst === null || parsedSecond === null) throw new Error('unread');

    await claimEdit(parsedFirst, leasesFor(registry, first));
    await registry.releaseSession('s1', NOW);

    expect(await claimEdit(parsedSecond, leasesFor(registry, second))).toBeNull();
  });

  it('takes nothing for a file outside the repository', async () => {
    const registry = new LeaseRegistry(await home(), () => true);
    const holder = { agent: 'claude-code', sessionId: 's1', pid: 101 };

    const outside = await claimEdit(
      { path: '/tmp/scratch.txt', sessionId: 's1', cwd: ROOT },
      leasesFor(registry, holder),
    );

    expect(outside).toBeNull();
    expect(await registry.held(NOW)).toEqual([]);
  });
});

/* A hook runs before the change lands, so the working tree cannot say which lines
   an edit is about to touch. The edit itself can. */
describe('the lines an edit is about to change', () => {
  const file = ['function a() {', '  return 1;', '}', ''].join('\n');

  it('reads the change an Edit, a MultiEdit and a Write each send', () => {
    const one = editOf({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      session_id: 's1',
      tool_input: {
        file_path: '/r/a.ts',
        old_string: 'return 1;',
        new_string: 'return 2;',
      },
    });
    expect(one?.change).toEqual({
      kind: 'edit',
      replacements: [{ from: 'return 1;', to: 'return 2;', all: false }],
    });

    const many = editOf({
      hook_event_name: 'PreToolUse',
      tool_name: 'MultiEdit',
      session_id: 's1',
      tool_input: {
        file_path: '/r/a.ts',
        edits: [
          { old_string: 'a()', new_string: 'b()' },
          { old_string: '1', new_string: '3', replace_all: true },
        ],
      },
    });
    expect(many?.change?.kind).toBe('edit');

    const write = editOf({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      session_id: 's1',
      tool_input: { file_path: '/r/a.ts', content: 'x' },
    });
    expect(write?.change).toEqual({ kind: 'write', content: 'x' });
  });

  /* Literally, as the tool writes it: `$&` in a replacement is text, not a
     pattern that repeats what it matched. */
  it('applies the replacements in order, the way the tool will', () => {
    expect(
      afterEdit(file, {
        kind: 'edit',
        replacements: [
          { from: 'a()', to: 'b()', all: false },
          { from: '1', to: '$&3', all: true },
        ],
      }),
    ).toBe(['function b() {', '  return $&3;', '}', ''].join('\n'));
  });

  /* An edit whose text is not in the file is one the tool will refuse; guessing
     where it meant would be a lease on the wrong lines. */
  it('knows nothing where the text to replace is not in the file', () => {
    expect(
      afterEdit(file, {
        kind: 'edit',
        replacements: [{ from: 'nope', to: 'x', all: false }],
      }),
    ).toBeNull();
  });
});

/* Where a person is at the agent, the decision is put to them in their own prompt
   rather than refused with a command to go and type. */
describe('asking the person at Claude Code', () => {
  it('asks only in the modes where Claude Code shows its person the prompt', () => {
    for (const mode of ['default', 'acceptEdits', 'plan']) {
      expect(canAskPerson({ permission_mode: mode })).toBe(true);
    }
    /* In bypassPermissions an ask is not honoured and the write would go ahead. */
    for (const mode of ['bypassPermissions', 'auto', 'dontAsk']) {
      expect(canAskPerson({ permission_mode: mode })).toBe(false);
    }
    expect(canAskPerson({})).toBe(false);
  });

  it('puts the question in the permission prompt', () => {
    expect(JSON.parse(editAsk('claude-code on laptop is editing retryCharge.'))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason:
          'claude-code on laptop is editing retryCharge. Allow to take these lines over? The other agent will be told.',
      },
    });
  });
});
