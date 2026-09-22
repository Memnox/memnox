import { describe, expect, it } from 'vitest';
import {
  agentDenial,
  agentEditsOf,
  beforeEdit,
  EDIT_HOST,
  endedSessionOf,
  parsePatch,
} from '../src/agent-edits';
import { afterEdit } from '../src/edit-hook';

/* Claude Code was the only editor whose writes met a lease, so an edit Codex or
   Cursor made on another computer was invisible to it, and theirs to it. */

const PATCH = [
  '*** Begin Patch',
  '*** Update File: src/billing.ts',
  '@@ export function retryCharge(attempt: number): boolean {',
  '-  const limit = 3;',
  '+  const limit = 5;',
  '   return attempt < limit;',
  '*** Add File: src/new.ts',
  '+export const x = 1;',
  '*** Delete File: src/old.ts',
  '*** End Patch',
].join('\n');

describe("Codex's patch", () => {
  it('reads every file a patch writes and what each hunk replaces', () => {
    expect(parsePatch(PATCH)).toEqual([
      {
        path: 'src/billing.ts',
        change: {
          kind: 'edit',
          replacements: [
            {
              from: '  const limit = 3;\n  return attempt < limit;',
              to: '  const limit = 5;\n  return attempt < limit;',
              all: false,
            },
          ],
        },
      },
      { path: 'src/new.ts', change: { kind: 'write', content: 'export const x = 1;\n' } },
      { path: 'src/old.ts' },
    ]);
  });

  it('turns an apply_patch call into one edit per file', () => {
    const found = agentEditsOf({
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      session_id: 'codex-1',
      cwd: '/repo',
      tool_input: { command: PATCH },
    });

    expect(found?.moment).toBe('before');
    expect(found?.host).toBe(EDIT_HOST.PRE_TOOL_USE);
    expect(found?.edits.map((each) => each.path)).toEqual([
      'src/billing.ts',
      'src/new.ts',
      'src/old.ts',
    ]);
    expect(found?.edits[0]?.cwd).toBe('/repo');
  });

  /* A hunk that only adds has no context to find its place by, so the file is
     claimed whole rather than at a guessed line. */
  it('claims the whole file for a hunk with nothing to find its place by', () => {
    const [file] = parsePatch('*** Update File: a.ts\n@@\n+added\n');
    expect(file).toEqual({ path: 'a.ts' });
  });

  it('applies to the file the way Codex will', () => {
    const before =
      'function retryCharge() {\n  const limit = 3;\n  return attempt < limit;\n}\n';
    const [file] = parsePatch(PATCH);
    if (file === undefined || file.change === undefined) throw new Error('no change');
    expect(afterEdit(before, file.change)).toBe(before.replace('limit = 3', 'limit = 5'));
  });
});

describe("Cursor's hooks", () => {
  it('reads a write before it happens, by the conversation it belongs to', () => {
    const found = agentEditsOf({
      hook_event_name: 'preToolUse',
      conversation_id: 'conv-1',
      workspace_roots: ['/repo'],
      tool_name: 'Write',
      tool_input: { file_path: '/repo/src/billing.ts', contents: 'new text' },
    });

    expect(found).toEqual({
      moment: 'before',
      host: EDIT_HOST.CURSOR,
      edits: [
        {
          path: '/repo/src/billing.ts',
          sessionId: 'conv-1',
          cwd: '/repo',
          change: { kind: 'write', content: 'new text' },
        },
      ],
    });
  });

  it('reads an edit once it is written, with the text it replaced', () => {
    const found = agentEditsOf({
      hook_event_name: 'afterFileEdit',
      conversation_id: 'conv-1',
      file_path: '/repo/src/billing.ts',
      edits: [{ old_string: 'limit = 3', new_string: 'limit = 5' }],
    });

    expect(found?.moment).toBe('after');
    expect(found?.edits[0]?.change).toEqual({
      kind: 'edit',
      replacements: [{ from: 'limit = 3', to: 'limit = 5', all: false }],
    });
  });

  it('says nothing about a tool that is not a write', () => {
    expect(
      agentEditsOf({
        hook_event_name: 'preToolUse',
        conversation_id: 'c',
        tool_name: 'Read',
        tool_input: { file_path: '/repo/a.ts' },
      }),
    ).toBeNull();
  });

  it('refuses in the words Cursor reads, to the person and to the model', () => {
    const answer = JSON.parse(
      agentDenial(EDIT_HOST.CURSOR, 'claude-code has these lines.'),
    ) as {
      permission: string;
      user_message: string;
      agent_message: string;
    };
    expect(answer.permission).toBe('deny');
    expect(answer.user_message).toBe('claude-code has these lines.');
    expect(answer.agent_message).toContain('come back to these lines later');
  });

  it('knows the session that ended, whichever agent ended it', () => {
    expect(endedSessionOf({ hook_event_name: 'sessionEnd', session_id: 'conv-1' })).toBe(
      'conv-1',
    );
    expect(endedSessionOf({ hook_event_name: 'SessionEnd', session_id: 'codex-1' })).toBe(
      'codex-1',
    );
  });
});

/* Cursor reports its edits once they are on disk, so the lines they changed are
   found by taking them back out. */
describe('an edit already written', () => {
  it('is undone to find the file as it was', () => {
    const after = 'a\nlimit = 5\nb\n';
    expect(
      beforeEdit(after, {
        kind: 'edit',
        replacements: [{ from: 'limit = 3', to: 'limit = 5', all: false }],
      }),
    ).toBe('a\nlimit = 3\nb\n');
  });

  it('knows nothing where the file changed since', () => {
    expect(
      beforeEdit('nothing here', {
        kind: 'edit',
        replacements: [{ from: 'x', to: 'y', all: false }],
      }),
    ).toBeNull();
  });
});

/* Gemini CLI and Windsurf write files from inside themselves too, and each reads
   a refusal its own way. */
describe('Gemini CLI and Windsurf', () => {
  it("reads Gemini CLI's replace and refuses in its words", () => {
    const found = agentEditsOf({
      hook_event_name: 'BeforeTool',
      session_id: 'g1',
      cwd: '/repo',
      tool_name: 'replace',
      tool_input: { file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' },
    });

    expect(found?.host).toBe(EDIT_HOST.GEMINI);
    expect(found?.edits[0]).toMatchObject({
      path: '/repo/a.ts',
      sessionId: 'g1',
      cwd: '/repo',
    });
    expect(
      JSON.parse(agentDenial(EDIT_HOST.GEMINI, 'claude-code has these lines.')),
    ).toMatchObject({
      decision: 'deny',
      reason: expect.stringContaining('claude-code has these lines.'),
    });
  });

  it("reads Windsurf's write before and after, by its conversation", () => {
    const payload = (action: string) => ({
      agent_action_name: action,
      trajectory_id: 't1',
      tool_info: {
        file_path: '/repo/src/a.ts',
        edits: [{ old_string: 'x', new_string: 'y' }],
      },
    });

    const before = agentEditsOf(payload('pre_write_code'));
    expect(before).toMatchObject({ moment: 'before', host: EDIT_HOST.WINDSURF });
    expect(before?.edits[0]).toMatchObject({ sessionId: 't1', cwd: '/repo/src' });
    expect(agentEditsOf(payload('post_write_code'))?.moment).toBe('after');
    /* Cascade shows the model what is on stderr, so the refusal is plain words. */
    expect(agentDenial(EDIT_HOST.WINDSURF, 'held.')).toContain(
      'held. Work on something else',
    );
  });
});
