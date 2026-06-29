import { describe, expect, it } from 'vitest';
import { mapHookPayload } from '../src/hook-mapping';

describe('mapHookPayload', () => {
  it('maps Bash commands to shell.execute with the command as target', () => {
    const request = mapHookPayload({
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
      session_id: 'session-1',
    });
    expect(request).toEqual({
      action: 'shell.execute',
      target: 'rm -rf /',
      sessionId: 'session-1',
    });
  });

  it('maps file tools to file.write with the path as target', () => {
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      const request = mapHookPayload({
        tool_name: tool,
        tool_input: { file_path: 'payment/checkout.ts' },
      });
      expect(request?.action).toBe('file.write');
      expect(request?.target).toBe('payment/checkout.ts');
    }
  });

  it('maps unknown tools to a namespaced tool action', () => {
    const request = mapHookPayload({ tool_name: 'WebFetch', tool_input: {} });
    expect(request?.action).toBe('tool.webfetch');
  });

  it('returns null when the payload cannot be mapped', () => {
    expect(mapHookPayload({})).toBeNull();
    expect(mapHookPayload({ tool_name: 'Bash', tool_input: {} })).toBeNull();
  });
});
