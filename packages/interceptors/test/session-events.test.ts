import { describe, expect, it } from 'vitest';
import { EDIT_HOST } from '../src/agent-edits';
import {
  activityOf,
  SESSION_MOMENT,
  sessionAnswer,
  sessionEventOf,
} from '../src/session-events';

const AT = '2026-09-22T10:00:00.000Z';

/* The two pauses every coding agent has: a tool call returned, a turn ended.
   Both are where a note is handed over, each in the words its host reads. */
describe('the pauses a session is handed notes at', () => {
  it('reads Claude Code and Codex, and Cursor, by their own event names', () => {
    expect(
      sessionEventOf({
        hook_event_name: 'PostToolUse',
        session_id: 's',
        tool_name: 'Read',
      }),
    ).toMatchObject({ moment: SESSION_MOMENT.AFTER_TOOL, host: EDIT_HOST.PRE_TOOL_USE });
    expect(
      sessionEventOf({ hook_event_name: 'stop', conversation_id: 'c' }),
    ).toMatchObject({
      moment: SESSION_MOMENT.TURN_END,
      host: EDIT_HOST.CURSOR,
      sessionId: 'c',
    });
    expect(sessionEventOf({ hook_event_name: 'PreToolUse', session_id: 's' })).toBeNull();
  });

  it('adds a note beside the result, or makes it the next thing to do at the end of a turn', () => {
    const after = {
      moment: SESSION_MOMENT.AFTER_TOOL,
      host: EDIT_HOST.PRE_TOOL_USE,
      sessionId: 's',
    };
    const end = { ...after, moment: SESSION_MOMENT.TURN_END };

    expect(JSON.parse(sessionAnswer(after, 'note'))).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'note' },
    });
    expect(JSON.parse(sessionAnswer(end, 'note'))).toEqual({
      decision: 'block',
      reason: 'note',
    });
    expect(sessionAnswer(after, null)).toBe('');
  });

  /* A note that waited through the end of a turn lands beside the person's next
     words, rather than waking a finished agent. */
  it('hands a note over beside the next prompt', () => {
    const prompt = sessionEventOf({
      hook_event_name: 'UserPromptSubmit',
      session_id: 's',
    });
    if (prompt === null) throw new Error('not read');

    expect(prompt.moment).toBe(SESSION_MOMENT.PROMPT);
    expect(JSON.parse(sessionAnswer(prompt, 'note'))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'note',
      },
    });
  });

  it("answers Cursor in Cursor's fields, and with an empty object when there is nothing", () => {
    const after = {
      moment: SESSION_MOMENT.AFTER_TOOL,
      host: EDIT_HOST.CURSOR,
      sessionId: 'c',
    };
    const end = { ...after, moment: SESSION_MOMENT.TURN_END };

    expect(JSON.parse(sessionAnswer(after, 'note'))).toEqual({
      additional_context: 'note',
    });
    expect(JSON.parse(sessionAnswer(end, 'note'))).toEqual({ followup_message: 'note' });
    expect(sessionAnswer(after, null)).toBe('{}');
  });
});

/* What the agent did, written down as it happens so the workspace sees the
   session working. Names and paths only. */
describe('what an agent did, as it did it', () => {
  it('records an edit and a read inside the agent, relative to where it works', () => {
    const edit = sessionEventOf({
      hook_event_name: 'PostToolUse',
      session_id: 's',
      cwd: '/repo',
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/src/billing.ts', old_string: 'a', new_string: 'b' },
    });
    if (edit === null) throw new Error('not read');

    const [row] = activityOf(edit, 'claude-code', undefined, AT);

    expect(row).toMatchObject({
      sessionId: 's',
      agent: 'claude-code',
      operation: 'file.edit',
      target: 'src/billing.ts',
      class: 'write',
    });
    expect(JSON.stringify(row)).not.toContain('old_string');
  });

  it('records each file a Codex patch wrote', () => {
    const patch = sessionEventOf({
      hook_event_name: 'PostToolUse',
      session_id: 's',
      tool_name: 'apply_patch',
      tool_input: {
        command:
          '*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** Add File: b.ts\n+z\n*** End Patch',
      },
    });
    if (patch === null) throw new Error('not read');

    expect(
      activityOf(patch, 'codex-cli', undefined, AT).map((each) => each.target),
    ).toEqual(['a.ts', 'b.ts']);
  });

  /* A shell command is already a row from the interceptor that ran it, and an
     MCP call from the proxy; recording them here would count each twice. */
  it('leaves shell commands and MCP calls to the seams that already record them', () => {
    for (const tool of ['Bash', 'mcp__slack__send_message']) {
      const event = sessionEventOf({
        hook_event_name: 'PostToolUse',
        session_id: 's',
        tool_name: tool,
      });
      if (event === null) throw new Error('not read');
      expect(activityOf(event, 'claude-code', undefined, AT)).toEqual([]);
    }
  });
});

describe('Gemini CLI and Windsurf at their pauses', () => {
  it('hands Gemini CLI a note after a tool, and keeps it working at the end of a turn', () => {
    const after = sessionEventOf({
      hook_event_name: 'AfterTool',
      session_id: 'g',
      tool_name: 'read_file',
    });
    const end = sessionEventOf({ hook_event_name: 'AfterAgent', session_id: 'g' });
    if (after === null || end === null) throw new Error('not read');

    expect(JSON.parse(sessionAnswer(after, 'note'))).toEqual({
      hookSpecificOutput: { hookEventName: 'AfterTool', additionalContext: 'note' },
    });
    expect(JSON.parse(sessionAnswer(end, 'note'))).toEqual({
      decision: 'deny',
      reason: 'note',
    });
  });

  /* Windsurf reads nothing back from its hooks, so the pause records and says nothing. */
  it("records Windsurf's write and answers nothing", () => {
    const pause = sessionEventOf({
      agent_action_name: 'post_write_code',
      trajectory_id: 't1',
      tool_info: { file_path: '/repo/src/a.ts' },
    });
    if (pause === null) throw new Error('not read');

    expect(activityOf(pause, 'windsurf', undefined, AT)[0]).toMatchObject({
      operation: 'file.edit',
      target: 'a.ts',
    });
    expect(sessionAnswer(pause, 'note')).toBe('');
  });
});
