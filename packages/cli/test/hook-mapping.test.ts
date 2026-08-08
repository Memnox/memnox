import { describe, expect, it } from 'vitest';
import { mapHookPayload } from '../src/hook-mapping';

/** Stands in for the repository the editor is working in. */
const onBranch = (branch: string | undefined) => (): string | undefined => branch;

describe('mapHookPayload', () => {
  it('maps Bash commands to shell.execute with the command as target', () => {
    const request = mapHookPayload(
      {
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
        session_id: 'session-1',
      },
      onBranch(undefined),
    );
    expect(request).toEqual({
      action: 'shell.execute',
      target: 'rm -rf /',
      sessionId: 'session-1',
      arguments: { command: 'rm -rf /' },
    });
  });

  it('maps file tools to file.write with the path as target', () => {
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      const request = mapHookPayload(
        {
          tool_name: tool,
          tool_input: { file_path: 'payment/checkout.ts' },
        },
        onBranch(undefined),
      );
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

  it('carries the working directory and branch a rule can match on', () => {
    const request = mapHookPayload(
      {
        tool_name: 'Bash',
        tool_input: { command: 'git push --force' },
        cwd: '/srv/checkout',
      },
      onBranch('release/24.3'),
    );

    expect(request?.workingDirectory).toBe('/srv/checkout');
    expect(request?.branch).toBe('release/24.3');
  });

  it('omits the branch outside a repository rather than inventing one', () => {
    const request = mapHookPayload(
      { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/tmp' },
      onBranch(undefined),
    );

    expect(request?.branch).toBeUndefined();
    expect(request?.workingDirectory).toBe('/tmp');
  });

  it('flattens every tool argument, structured ones included, for matching', () => {
    const request = mapHookPayload(
      {
        tool_name: 'NotebookEdit',
        tool_input: {
          notebook_path: 'analysis.ipynb',
          edit_mode: 'replace',
          cells: [{ index: 0 }],
        },
      },
      onBranch(undefined),
    );

    expect(request?.arguments).toEqual({
      notebook_path: 'analysis.ipynb',
      edit_mode: 'replace',
      cells: '[{"index":0}]',
    });
  });
});
