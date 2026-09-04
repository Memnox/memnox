import { describe, expect, it } from 'vitest';
import { readHookInput } from '../src/hook-input';
import { HOOK_COVERS, TOOL_ACTIONS, toActionRequest } from '../src/tool-action';
import { HOOK_EVENT_NAME } from '../src/tool-hook.constants';

function payload(toolName: string, toolInput: Record<string, unknown>): string {
  return JSON.stringify({
    hook_event_name: HOOK_EVENT_NAME,
    session_id: 'ses_1',
    cwd: '/srv/checkout',
    tool_name: toolName,
    tool_input: toolInput,
  });
}

function read(
  toolName: string,
  toolInput: Record<string, unknown>,
): ReturnType<typeof readHookInput> {
  return readHookInput(payload(toolName, toolInput));
}

describe('readHookInput', () => {
  it('reads the fields this seam rules on', () => {
    const input = read('Read', { file_path: '/home/dev/.env' });
    expect(input).toEqual({
      toolName: 'Read',
      toolInput: { file_path: '/home/dev/.env' },
      sessionId: 'ses_1',
      workingDirectory: '/srv/checkout',
    });
  });

  it('flattens structured arguments to text, which is what a policy matches', () => {
    const input = read('Bash', { command: 'ls', timeout: 120, run_in_background: false });
    expect(input?.toolInput).toEqual({
      command: 'ls',
      timeout: '120',
      run_in_background: 'false',
    });
  });

  it('refuses a payload it cannot rule on rather than guessing', () => {
    expect(readHookInput('not json')).toBeNull();
    expect(readHookInput('[]')).toBeNull();
    expect(readHookInput(JSON.stringify({ hook_event_name: 'PostToolUse' }))).toBeNull();
    expect(
      readHookInput(JSON.stringify({ hook_event_name: HOOK_EVENT_NAME })),
    ).toBeNull();
  });

  it('leaves an absent optional field absent rather than empty', () => {
    const input = readHookInput(
      JSON.stringify({ hook_event_name: HOOK_EVENT_NAME, tool_name: 'Read' }),
    );
    expect(input).toEqual({ toolName: 'Read', toolInput: {} });
  });
});

describe('toActionRequest', () => {
  it('maps a read to the action the harden step writes a rule about', () => {
    const request = toActionRequest(read('Read', { file_path: '/home/dev/.env' })!);
    expect(request?.action).toBe('filesystem.read');
    expect(request?.target).toBe('/home/dev/.env');
  });

  it('carries the arguments for the local gate and the session for the timeline', () => {
    const request = toActionRequest(read('Bash', { command: 'rm -rf /tmp/build' })!);
    expect(request?.action).toBe('shell.execute');
    expect(request?.target).toBe('rm -rf /tmp/build');
    expect(request?.arguments).toEqual({ command: 'rm -rf /tmp/build' });
    expect(request?.sessionId).toBe('ses_1');
    expect(request?.workingDirectory).toBe('/srv/checkout');
  });

  it('names an edit a write, because whether the file is code is an inference', () => {
    expect(toActionRequest(read('Edit', { file_path: 'a.yaml' })!)?.action).toBe(
      'file.write',
    );
    expect(toActionRequest(read('Write', { file_path: 'a.ts' })!)?.action).toBe(
      'file.write',
    );
  });

  it('falls through target fields in order, skipping empty ones', () => {
    expect(toActionRequest(read('Grep', { path: '/srv', pattern: 'x' })!)?.target).toBe(
      '/srv',
    );
    expect(toActionRequest(read('Grep', { path: '', pattern: 'x' })!)?.target).toBe('x');
    expect(toActionRequest(read('Grep', {})!)?.target).toBeUndefined();
  });

  it('rules on nothing it was not installed for, rather than guessing an action', () => {
    expect(toActionRequest(read('TodoWrite', {})!)).toBeNull();
    expect(toActionRequest(read('mcp__github__create_issue', {})!)).toBeNull();
  });

  it('attaches the governance unit when the caller resolved one', () => {
    const request = toActionRequest(read('Read', { file_path: 'a' })!, {
      projectId: 'checkout',
      environment: 'production',
    });
    expect(request?.projectId).toBe('checkout');
    expect(request?.environment).toBe('production');
  });

  it('declares every action it can produce, so coverage cannot drift', () => {
    const produced = new Set(Object.values(TOOL_ACTIONS).map((spec) => spec.action));
    expect(new Set(HOOK_COVERS)).toEqual(produced);
  });
});
