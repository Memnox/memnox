import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
import { CONTENT_METADATA_KEY } from '@memnox/content-shield';
import {
  CURSOR_AFTER_FILE_EDIT,
  CURSOR_BLOCKING_EVENTS,
  CURSOR_PERMISSION,
  mapCursorPayload,
  toCursorPermission,
} from '../src/cursor-hook-mapping';

describe('toCursorPermission', () => {
  it('maps each Memnox effect onto Cursor’s own vocabulary', () => {
    expect(toCursorPermission(DECISION_EFFECT.ALLOW)).toBe(CURSOR_PERMISSION.ALLOW);
    expect(toCursorPermission(DECISION_EFFECT.BLOCK)).toBe(CURSOR_PERMISSION.DENY);
    expect(toCursorPermission(DECISION_EFFECT.REQUIRE_APPROVAL)).toBe(
      CURSOR_PERMISSION.ASK,
    );
  });
});

describe('mapCursorPayload — beforeShellExecution', () => {
  it('maps the command onto shell.execute', () => {
    const request = mapCursorPayload({
      hook_event_name: CURSOR_BLOCKING_EVENTS.BEFORE_SHELL,
      command: 'rm -rf /tmp/build',
      conversation_id: 'conv-1',
    });
    expect(request?.action).toBe('shell.execute');
    expect(request?.target).toBe('rm -rf /tmp/build');
    expect(request?.sessionId).toBe('conv-1');
  });

  it('ignores an event with no command', () => {
    expect(
      mapCursorPayload({ hook_event_name: CURSOR_BLOCKING_EVENTS.BEFORE_SHELL }),
    ).toBeNull();
  });
});

describe('mapCursorPayload — beforeMCPExecution', () => {
  it('namespaces the MCP tool and parses the JSON-string params', () => {
    const request = mapCursorPayload({
      hook_event_name: CURSOR_BLOCKING_EVENTS.BEFORE_MCP,
      tool_name: 'GitHub_CreateIssue',
      tool_input: JSON.stringify({ url: 'https://api.github.com/issues' }),
    });
    expect(request?.action).toBe('mcp.github_createissue');
    expect(request?.target).toBe('https://api.github.com/issues');
  });

  it('still governs the call when params are unparseable', () => {
    const request = mapCursorPayload({
      hook_event_name: CURSOR_BLOCKING_EVENTS.BEFORE_MCP,
      tool_name: 'Whatever',
      tool_input: 'not json',
    });
    expect(request?.action).toBe('mcp.whatever');
    expect(request?.target).toBeUndefined();
  });
});

describe('mapCursorPayload — beforeReadFile', () => {
  it('maps to file.read', () => {
    const request = mapCursorPayload({
      hook_event_name: CURSOR_BLOCKING_EVENTS.BEFORE_READ_FILE,
      file_path: 'src/.env',
    });
    expect(request?.action).toBe('file.read');
    expect(request?.target).toBe('src/.env');
  });
});

describe('mapCursorPayload — preToolUse', () => {
  it('detects a shell command inside tool_input', () => {
    const request = mapCursorPayload({
      hook_event_name: CURSOR_BLOCKING_EVENTS.PRE_TOOL_USE,
      tool_name: 'Shell',
      tool_input: { command: 'npm publish' },
    });
    expect(request?.action).toBe('shell.execute');
    expect(request?.target).toBe('npm publish');
  });

  it('detects a file write and forwards content for secret scanning', () => {
    const request = mapCursorPayload({
      hook_event_name: CURSOR_BLOCKING_EVENTS.PRE_TOOL_USE,
      tool_name: 'Write',
      tool_input: { file_path: 'src/a.ts', content: 'export const a = 1;' },
    });
    expect(request?.action).toBe('file.write');
    expect(request?.target).toBe('src/a.ts');
    expect(request?.metadata?.[CONTENT_METADATA_KEY]).toBe('export const a = 1;');
  });

  it('falls back to a namespaced tool action for anything else', () => {
    const request = mapCursorPayload({
      hook_event_name: CURSOR_BLOCKING_EVENTS.PRE_TOOL_USE,
      tool_name: 'SearchWeb',
      tool_input: {},
    });
    expect(request?.action).toBe('tool.searchweb');
  });

  it('ignores an event with no tool name', () => {
    expect(
      mapCursorPayload({ hook_event_name: CURSOR_BLOCKING_EVENTS.PRE_TOOL_USE }),
    ).toBeNull();
  });
});

describe('mapCursorPayload — afterFileEdit', () => {
  it('joins the applied edits so the shield can scan what landed', () => {
    const request = mapCursorPayload({
      hook_event_name: CURSOR_AFTER_FILE_EDIT,
      file_path: 'src/a.ts',
      edits: [
        { old_string: 'a', new_string: 'const a = 1;' },
        { old_string: 'b', new_string: 'const b = 2;' },
      ],
    });
    expect(request?.action).toBe('file.write');
    expect(request?.metadata?.[CONTENT_METADATA_KEY]).toBe('const a = 1;\nconst b = 2;');
  });
});

describe('mapCursorPayload — unknown events', () => {
  it('returns null rather than inventing an action', () => {
    expect(mapCursorPayload({ hook_event_name: 'sessionStart' })).toBeNull();
    expect(mapCursorPayload({})).toBeNull();
  });
});
